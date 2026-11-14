'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { createIdentity, deriveKey, seal, open } = require('../shared/crypto');
const { createStore } = require('./store');
const { forwardRequest } = require('./upstream');

const UI_DIR = path.join(__dirname, '..', 'ui');
const MAX_BODY = 30 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function fail(res, status, message) {
  send(res, status, { error: message });
}

function protoError(res, protocol, status, message) {
  const type = status === 429 ? 'rate_limit_error' : status === 503 ? 'overloaded_error' : 'invalid_request_error';
  const body = protocol === 'anthropic'
    ? { type: 'error', error: { type, message } }
    : { error: { type, message } };
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

function bearer(h) {
  const m = /^Bearer\s+(.+)$/i.exec(h || '');
  return m ? m[1].trim() : '';
}

function maskKey(key) {
  return key.length <= 8 ? '****' : key.slice(0, 3) + '…' + key.slice(-4);
}

function fingerprint(pub) {
  return crypto.createHash('sha256').update(String(pub.x) + String(pub.y)).digest('hex').slice(0, 16);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function startClient({
  guiPort = Number(process.env.CLIENT_PORT) || 8787,
  proxyPort = Number(process.env.PROXY_PORT) || 8788,
  host = '127.0.0.1',
  dataDir = process.env.CLIENT_DATA_DIR || path.join(process.cwd(), 'client-data'),
} = {}) {
  const store = createStore(dataDir);
  let config = store.getConfig();
  let providers = store.getProviders();
  let peers = [];
  let shareIndex = new Map();
  const pairKeys = new Map();
  let agent = null;
  let agentReady = false;
  let stopping = false;

  async function relay(pathname, { method = 'GET', body } = {}) {
    if (!config) throw Object.assign(new Error('还没连接中转服务器'), { status: 400 });
    const res = await fetch(config.relayUrl + pathname, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  async function refreshPeers() {
    if (!config) return [];
    peers = await relay('/api/peers');
    const idx = new Map();
    for (const p of peers) for (const s of p.shares) idx.set(s.key, { peer: p, share: s });
    shareIndex = idx;
    return peers;
  }

  async function pairKey(peerId, peerPub) {
    if (!pairKeys.has(peerId)) {
      pairKeys.set(peerId, deriveKey(config.priv, peerPub));
    }
    return pairKeys.get(peerId);
  }

  function connectAgent() {
    if (!config || stopping) return;
    const url = config.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/agent';
    const ws = new WebSocket(url);
    agent = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: config.token })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'ready') {
        agentReady = true;
        refreshPeers().catch(() => {});
        return;
      }
      if (msg.t === 'req') {
        handleAgentRequest(msg, ws).catch((err) => {
          console.error('agent request failed', err);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: 'res-error', id: msg.id, message: err.message || '本机处理失败' }));
          }
        });
      }
    });
    ws.on('close', () => {
      agentReady = false;
      if (!stopping) setTimeout(connectAgent, 3000);
    });
    ws.on('error', () => {});
  }

  async function handleAgentRequest(msg, ws) {
    const provider = providers.find((p) => p.id === msg.providerId);
    if (!provider) throw new Error('本机找不到这个供应商，请在“我的 API”里重新添加并重建通道');
    const key = await pairKey(msg.peerId, msg.peerPub);
    const envelope = JSON.parse((await open(key, msg.body)).toString('utf8'));
    const bodyBuf = Buffer.from(envelope.body || '', 'base64');
    const result = await forwardRequest({
      provider,
      protocol: msg.protocol,
      method: msg.method || 'POST',
      fullPath: msg.path,
      search: msg.search || '',
      headers: envelope.headers || {},
      bodyBuf,
      onStart: (status, headers) => {
        ws.send(JSON.stringify({ t: 'res-start', id: msg.id, status, headers }));
      },
      onChunk: async (buf) => {
        ws.send(JSON.stringify({ t: 'res-chunk', id: msg.id, data: await seal(key, buf) }));
      },
    });
    ws.send(JSON.stringify({ t: 'res-end', id: msg.id, ...result }));
  }

  async function proxyRoute(req, res, url) {
    const fullPath = url.pathname.startsWith('/v1/') ? url.pathname : '/v1' + url.pathname;
    const protocol = fullPath.startsWith('/v1/messages') ? 'anthropic' : 'openai';
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const shareKey = auth ? auth[1].trim() : String(req.headers['x-api-key'] || '');

    let hit = shareIndex.get(shareKey);
    if (!hit) {
      try { await refreshPeers(); } catch {}
      hit = shareIndex.get(shareKey);
    }
    if (!hit) return protoError(res, protocol, 401, '本机不认识这个共享 Key，请先打开客户端刷新');
    if (!hit.share.provider || hit.share.provider.protocol !== protocol) {
      return protoError(res, protocol, 400, '这个通道的协议和当前客户端不匹配');
    }

    const key = await pairKey(hit.peer.id, hit.peer.pubKey);
    const bodyBuf = await readBody(req, MAX_BODY);
    const envelope = JSON.stringify({ headers: req.headers, body: bodyBuf.toString('base64') });
    const sealed = await seal(key, Buffer.from(envelope));

    let upstream;
    try {
      upstream = await fetch(config.relayUrl + fullPath + url.search, {
        method: req.method,
        headers: { authorization: `Bearer ${shareKey}`, 'content-type': 'application/json' },
        body: sealed,
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
    } catch (err) {
      return protoError(res, protocol, 502, `中转不可用: ${err.message}`);
    }

    const status = upstream.headers.get('x-ccshare-status');
    if (!status) {
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      return res.end(text);
    }

    const headers = JSON.parse(
      Buffer.from(upstream.headers.get('x-ccshare-headers') || '', 'base64url').toString('utf8') || '{}',
    );
    const outHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k)) outHeaders[k] = v;
    }
    res.writeHead(Number(status), outHeaders);

    const dec = new TextDecoder();
    let buf = '';
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.t === 'chunk') res.write(await open(key, frame.data));
        if (frame.t === 'error') res.write(Buffer.from(`\n[ccswitch-share] ${frame.message}\n`));
      }
    }
    res.end();
  }

  async function apiRoute(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const resource = parts[1] || '';
    const sub = parts[2] || '';

    if (resource === 'me' && req.method === 'GET') {
      return send(res, 200, config
        ? {
          configured: true,
          id: config.memberId,
          name: config.name,
          relayUrl: config.relayUrl,
          relayOnline: agentReady,
          proxyPort,
          fingerprint: fingerprint(config.pub),
        }
        : { configured: false, proxyPort });
    }

    if (resource === 'onboard' && req.method === 'POST') {
      const b = await readJson(req);
      const name = String(b.name || '').trim().slice(0, 40);
      let relayUrl = String(b.relayUrl || '').trim().replace(/\/+$/, '');
      if (relayUrl && !/^https?:\/\//.test(relayUrl)) relayUrl = 'https://' + relayUrl;
      if (!name || !/^https?:\/\//.test(relayUrl)) return fail(res, 400, '请填写服务器地址和昵称');
      const identity = await createIdentity();
      const r = await fetch(relayUrl + '/api/onboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, pubKey: identity.pub }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      if (!r.ok) return fail(res, r.status, data.error || '注册失败');
      config = {
        relayUrl,
        token: data.token,
        memberId: data.memberId,
        name,
        pub: identity.pub,
        priv: identity.priv,
      };
      store.setConfig(config);
      pairKeys.clear();
      if (agent) agent.close();
      connectAgent();
      return send(res, 200, { id: config.memberId, name, relayUrl });
    }

    if (resource === 'reset' && req.method === 'POST') {
      stopping = true;
      if (agent) agent.close();
      agent = null;
      agentReady = false;
      config = null;
      store.clearConfig();
      peers = [];
      shareIndex = new Map();
      pairKeys.clear();
      stopping = false;
      return send(res, 200, { ok: true });
    }

    if (!config) return fail(res, 400, '还没连接中转服务器');

    if (resource === 'providers') {
      if (req.method === 'GET') {
        return send(res, 200, providers.map((p) => ({ ...p, apiKey: maskKey(p.apiKey) })));
      }
      if (req.method === 'POST') {
        const b = await readJson(req);
        const clean = cleanProvider(b);
        if (clean.error) return fail(res, 400, clean.error);
        const row = { id: crypto.randomUUID(), ...clean.value, createdAt: Date.now() };
        providers = [...providers, row];
        store.setProviders(providers);
        return send(res, 200, { id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.baseUrl });
      }
      if (sub && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const own = providers.find((p) => p.id === sub);
        if (!own) return fail(res, 404, '供应商不存在');
        if (req.method === 'DELETE') {
          providers = providers.filter((p) => p.id !== sub);
          store.setProviders(providers);
          try {
            const shares = await relay('/api/shares');
            for (const s of shares) {
              if (s.provider.id === sub) await relay('/api/shares/' + s.id, { method: 'DELETE' });
            }
          } catch {}
          return send(res, 200, { ok: true });
        }
        const b = await readJson(req);
        const clean = cleanProvider({
          name: b.name ?? own.name,
          protocol: b.protocol ?? own.protocol,
          baseUrl: b.baseUrl ?? own.baseUrl,
          apiKey: b.apiKey || own.apiKey,
        });
        if (clean.error) return fail(res, 400, clean.error);
        providers = providers.map((p) => (p.id === sub ? { ...p, ...clean.value } : p));
        store.setProviders(providers);
        return send(res, 200, { id: sub, name: clean.value.name, protocol: clean.value.protocol, baseUrl: clean.value.baseUrl });
      }
    }

    if (resource === 'shares') {
      if (req.method === 'GET') return send(res, 200, await relay('/api/shares'));
      if (req.method === 'POST') {
        const b = await readJson(req);
        const provider = providers.find((p) => p.id === String(b.providerId || ''));
        if (!provider) return fail(res, 400, '先添加要共享的本机 API');
        const created = await relay('/api/shares', {
          method: 'POST',
          body: {
            consumerId: b.consumerId,
            providerId: provider.id,
            providerName: provider.name,
            protocol: provider.protocol,
            name: b.name,
            dailyTokenLimit: b.dailyTokenLimit,
          },
        });
        return send(res, 200, created);
      }
      if (sub && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const body = req.method === 'PATCH' ? await readJson(req) : undefined;
        const out = await relay('/api/shares/' + sub, { method: req.method, body });
        return send(res, 200, out);
      }
    }

    if (resource === 'peers' && req.method === 'GET') {
      const list = await refreshPeers();
      return send(res, 200, list.map((p) => ({ ...p, fingerprint: fingerprint(p.pubKey) })));
    }
    if (resource === 'pair' && req.method === 'GET') return send(res, 200, await relay('/api/pair'));
    if (resource === 'pair' && sub === 'code' && req.method === 'POST') {
      return send(res, 200, await relay('/api/pair/code', { method: 'POST' }));
    }
    if (resource === 'pair' && sub === 'redeem' && req.method === 'POST') {
      const out = await relay('/api/pair/redeem', { method: 'POST', body: await readJson(req) });
      pairKeys.clear();
      await refreshPeers().catch(() => {});
      return send(res, 200, out);
    }
    if (resource === 'requests' && req.method === 'GET') {
      return send(res, 200, await relay('/api/requests' + url.search));
    }

    return fail(res, 404, 'not found');
  }

  function cleanProvider(b) {
    const name = String(b.name || '').trim().slice(0, 40);
    const protocol = b.protocol === 'openai' ? 'openai' : b.protocol === 'anthropic' ? 'anthropic' : '';
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(b.apiKey || '').trim();
    if (!name) return { error: '名称不能为空' };
    if (!protocol) return { error: '协议必须是 anthropic 或 openai' };
    if (!/^https?:\/\//.test(baseUrl)) return { error: 'Base URL 必须以 http(s):// 开头' };
    if (!apiKey) return { error: 'API Key 不能为空' };
    return { value: { name, protocol, baseUrl, apiKey } };
  }

  const gui = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await apiRoute(req, res, url);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);
      return fail(res, 404, 'not found');
    } catch (err) {
      if (res.headersSent) return res.end();
      return fail(res, err.status || 500, err.status ? err.message : '本机服务出错');
    }
  });

  const proxy = http.createServer(async (req, res) => {
    res.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    try {
      return await proxyRoute(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      return fail(res, 500, err.message || '本机代理出错');
    }
  });

  const listen = (server, port, label) => new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(
      `${label}端口 ${port} 无法监听（${err.code || err.message}）；用 CLIENT_PORT / PROXY_PORT 换一个端口`,
    )));
    server.listen(port, host, resolve);
  });
  await listen(gui, guiPort, '界面');
  await listen(proxy, proxyPort, '本机代理');
  const actualGuiPort = gui.address().port;
  const actualProxyPort = proxy.address().port;
  if (config) connectAgent();
  const refreshTimer = setInterval(() => {
    if (config) refreshPeers().catch(() => {});
  }, 60000);
  refreshTimer.unref();

  return {
    guiPort: actualGuiPort,
    proxyPort: actualProxyPort,
    close: () => {
      stopping = true;
      clearInterval(refreshTimer);
      if (agent) agent.close();
      gui.close();
      proxy.close();
    },
  };
}

module.exports = { startClient };

if (require.main === module) {
  startClient()
    .then(({ guiPort, proxyPort }) => {
      console.log(`ccswitch-share client: 打开 http://127.0.0.1:${guiPort}`);
      console.log(`Claude Code / Codex 指向 http://127.0.0.1:${proxyPort}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
