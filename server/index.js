'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const { createApi } = require('./api');

const MAX_BODY = 30 * 1024 * 1024;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function cipherFor(secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  return {
    enc(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const out = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
    },
    dec(payload) {
      const b = Buffer.from(payload, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'relay.db'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS members(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      pub_key TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS links(
      a TEXT NOT NULL, b TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(a, b));
    CREATE TABLE IF NOT EXISTS shares(
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, provider_name TEXT NOT NULL, protocol TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE, key_enc TEXT NOT NULL,
      daily_token_limit INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT, owner_id TEXT, consumer_id TEXT,
      protocol TEXT, path TEXT, model TEXT, status INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      estimated INTEGER DEFAULT 0, duration_ms INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_requests_share_time ON requests(share_id, created_at);
  `);
  return db;
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

async function startServer({
  port = Number(process.env.PORT) || 8787,
  host = '0.0.0.0',
  dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  secret,
  pairTtlMs = 10 * 60 * 1000,
  retentionDays = Number(process.env.RETENTION_DAYS) || 7,
} = {}) {
  if (!secret) throw new Error('SECRET is required');
  const db = openDb(dataDir);
  const cipher = cipherFor(secret);
  const codes = new Map();
  const attempts = new Map();
  const sockets = new Map();
  const pending = new Map();
  const isOnline = (memberId) => sockets.has(memberId);
  const apiRoute = createApi({ db, cipher, codes, attempts, pairTtlMs, isOnline });

  function cleanupPending(id, message) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    try {
      if (!p.started) protoError(p.res, p.protocol, 504, message);
      else {
        p.res.write(JSON.stringify({ t: 'error', message }) + '\n');
        p.res.end();
      }
    } catch {}
  }

  function logRequest(share, protocol, reqPath, status, usage, duration) {
    try {
      db.prepare(
        `INSERT INTO requests(share_id, owner_id, consumer_id, protocol, path, model, status,
          input_tokens, output_tokens, estimated, duration_ms, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        share.id, share.owner_id, share.consumer_id, protocol, reqPath, usage.model || null,
        status, usage.input || 0, usage.output || 0, usage.estimated ? 1 : 0, duration, Date.now(),
      );
    } catch (err) {
      console.error('log failed', err);
    }
  }

  async function proxyRoute(req, res, url) {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'ccswitch-share relay' }));
    }

    const fullPath = url.pathname.startsWith('/v1/') ? url.pathname : '/v1' + url.pathname;
    const protocol = fullPath.startsWith('/v1/messages') ? 'anthropic' : 'openai';
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const key = auth ? auth[1].trim() : String(req.headers['x-api-key'] || '');
    if (!key.startsWith('sk-share-')) return protoError(res, protocol, 401, '缺少共享 Key');

    const share = db.prepare('SELECT * FROM shares WHERE key_hash = ?').get(sha256(key));
    if (!share) return protoError(res, protocol, 401, '共享 Key 无效');
    if (!share.enabled) return protoError(res, protocol, 403, '共享通道已停用');
    if (share.protocol !== protocol) {
      return protoError(res, protocol, 400, `该通道是 ${share.protocol} 协议，不能用于当前客户端`);
    }

    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const used = db.prepare(
      'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM requests WHERE share_id = ? AND created_at >= ?',
    ).get(share.id, day.getTime()).t;
    if (used >= share.daily_token_limit) {
      return protoError(res, protocol, 429, `今日额度已用完（${used}/${share.daily_token_limit} tokens）`);
    }

    const owner = sockets.get(share.owner_id);
    if (!owner) return protoError(res, protocol, 503, '对方的客户端不在线，请让对方打开客户端');

    const consumer = db.prepare('SELECT pub_key FROM members WHERE id = ?').get(share.consumer_id);
    if (!consumer) return protoError(res, protocol, 503, '共享方身份已失效');

    let bodyBuf;
    try {
      bodyBuf = await readBody(req, MAX_BODY);
    } catch {
      return protoError(res, protocol, 413, '请求体过大');
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => cleanupPending(id, '对方客户端响应超时'), 60000);
    pending.set(id, {
      res, share, protocol, path: fullPath, startedAt: Date.now(), started: false, timer,
    });

    owner.send(JSON.stringify({
      t: 'req',
      id,
      shareId: share.id,
      providerId: share.provider_id,
      protocol,
      path: fullPath,
      search: url.search,
      method: req.method,
      body: bodyBuf.toString('utf8'),
      peerId: share.consumer_id,
      peerPub: JSON.parse(consumer.pub_key),
    }));
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await apiRoute(req, res, url);
      return await proxyRoute(req, res, url);
    } catch (err) {
      console.error(err);
      if (res.headersSent) return res.end();
      res.writeHead(err.status || 500, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.status ? err.message : '服务器内部错误' }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/agent') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let memberId = null;
    const guard = setTimeout(() => ws.close(), 10000);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!memberId) {
        if (msg.t !== 'hello' || !msg.token) return ws.close();
        const member = db.prepare('SELECT id FROM members WHERE token_hash = ?').get(sha256(String(msg.token)));
        if (!member) return ws.close();
        memberId = member.id;
        sockets.set(memberId, ws);
        clearTimeout(guard);
        ws.send(JSON.stringify({ t: 'ready' }));
        return;
      }

      const p = msg.id ? pending.get(msg.id) : null;
      if (!p) return;

      if (msg.t === 'res-start') {
        if (p.started) return;
        p.started = true;
        clearTimeout(p.timer);
        p.timer = setTimeout(() => cleanupPending(msg.id, '响应超时'), 30 * 60 * 1000);
        p.res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'x-ccshare-status': String(msg.status || 200),
          'x-ccshare-headers': Buffer.from(JSON.stringify(msg.headers || {})).toString('base64url'),
        });
        return;
      }
      if (msg.t === 'res-chunk' && p.started) {
        p.res.write(JSON.stringify({ t: 'chunk', data: msg.data }) + '\n');
        return;
      }
      if (msg.t === 'res-end') {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.res.write(JSON.stringify({ t: 'end' }) + '\n');
        p.res.end();
        logRequest(p.share, p.protocol, p.path, Number(msg.status) || 0, {
          input: Number(msg.input) || 0,
          output: Number(msg.output) || 0,
          estimated: !!msg.estimated,
          model: msg.model,
        }, Date.now() - p.startedAt);
        return;
      }
      if (msg.t === 'res-error') {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (!p.started) return protoError(p.res, p.protocol, 502, String(msg.message || '对方的 API 请求失败'));
        p.res.write(JSON.stringify({ t: 'error', message: String(msg.message || '') }) + '\n');
        p.res.end();
      }
    });

    ws.on('close', () => {
      clearTimeout(guard);
      if (memberId && sockets.get(memberId) === ws) sockets.delete(memberId);
      for (const [id, p] of pending) {
        if (p.share.owner_id !== memberId) continue;
        pending.delete(id);
        clearTimeout(p.timer);
        if (!p.started) protoError(p.res, p.protocol, 503, '对方客户端已断开');
        else {
          p.res.write(JSON.stringify({ t: 'error', message: '对方客户端已断开' }) + '\n');
          p.res.end();
        }
      }
    });
  });

  const cleanup = () => {
    db.prepare('DELETE FROM requests WHERE created_at < ?').run(Date.now() - retentionDays * 86400000);
  };
  cleanup();
  const timer = setInterval(cleanup, 86400000);
  timer.unref();

  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: server.address().port,
    close: () => {
      clearInterval(timer);
      for (const ws of sockets.values()) ws.terminate();
      wss.close();
      server.close();
      db.close();
    },
  };
}

module.exports = { startServer };

if (require.main === module) {
  const secret = process.env.SECRET;
  if (!secret) {
    console.error('SECRET is required (e.g. SECRET=$(openssl rand -hex 32) node server/index.js)');
    process.exit(1);
  }
  startServer({ secret })
    .then(({ port }) => console.log(`ccswitch-share relay listening on http://0.0.0.0:${port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
