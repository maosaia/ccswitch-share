'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./index');
const { startClient } = require('../client');
const { createIdentity } = require('../shared/crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccshare-${name}-`));
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function read(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

async function call(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

async function waitFor(fn, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() - started > timeout) throw new Error('timeout');
    await sleep(50);
  }
}

test('end-to-end encrypted share: relay never sees prompts or keys', async (t) => {
  const seen = { messages: null, chat: null };
  const upstream = await listen(async (req, res) => {
    const body = await read(req);
    if (req.url === '/v1/messages') {
      seen.messages = { headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_1',
        choices: [{ message: { content: 'TOPSECRET_REPLY' } }],
        usage: { input_tokens: 12, output_tokens: 6 },
      }));
    }
    if (req.url === '/v1/chat/completions') {
      seen.chat = { headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404).end();
  });

  const relayDir = tmpDir('relay');
  const dirA = tmpDir('a');
  const dirB = tmpDir('b');
  const relay = await startServer({ port: 0, host: '127.0.0.1', dataDir: relayDir, secret: 'test-secret' });
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const a = await startClient({ guiPort: 0, proxyPort: 0, dataDir: dirA });
  const b = await startClient({ guiPort: 0, proxyPort: 0, dataDir: dirB });

  t.after(() => {
    a.close();
    b.close();
    relay.close();
    upstream.server.close();
    for (const d of [relayDir, dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
  });

  const alice = await call(a.guiPort, '/api/onboard', {
    method: 'POST', body: { relayUrl, name: 'Alice' },
  });
  assert.equal(alice.status, 200);
  const bob = await call(b.guiPort, '/api/onboard', {
    method: 'POST', body: { relayUrl, name: 'Bob' },
  });
  assert.equal(bob.status, 200);

  await waitFor(async () => (await call(a.guiPort, '/api/me')).json.relayOnline === true);
  await waitFor(async () => (await call(b.guiPort, '/api/me')).json.relayOnline === true);

  const bMe = (await call(b.guiPort, '/api/me')).json;

  const provider = await call(a.guiPort, '/api/providers', {
    method: 'POST',
    body: {
      name: 'claude',
      protocol: 'anthropic',
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: 'sk-upstream-secret',
    },
  });
  assert.equal(provider.status, 200);

  const pair = (await call(a.guiPort, '/api/pair/code', { method: 'POST' })).json;
  assert.match(pair.code, /^\d{6}$/);
  const redeemed = await call(b.guiPort, '/api/pair/redeem', {
    method: 'POST', body: { code: pair.code },
  });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.json.peer.name, 'Alice');

  const share = (await call(a.guiPort, '/api/shares', {
    method: 'POST',
    body: {
      providerId: provider.json.id,
      consumerId: bMe.id,
      name: '给 Bob',
      dailyTokenLimit: 1000,
    },
  })).json;
  assert.match(share.key, /^sk-share-/);

  const peerView = (await call(b.guiPort, '/api/peers')).json;
  assert.equal(peerView[0].name, 'Alice');
  assert.equal(peerView[0].shares[0].key, share.key);
  assert.equal(peerView[0].online, true);

  const proxied = await fetch(`http://127.0.0.1:${b.proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': share.key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-3',
      messages: [{ role: 'user', content: 'TOPSECRET_PROMPT' }],
    }),
  });
  const proxiedBody = await proxied.text();
  assert.equal(proxied.status, 200, proxiedBody);
  assert.match(proxiedBody, /TOPSECRET_REPLY/);
  assert.match(seen.messages.body, /TOPSECRET_PROMPT/);
  assert.equal(seen.messages.headers['x-api-key'], 'sk-upstream-secret');
  assert.equal(seen.messages.headers.authorization, undefined);

  const shares = (await call(a.guiPort, '/api/shares')).json;
  assert.equal(shares[0].usageToday, 18);
  assert.equal(shares[0].series.length, 7);

  const logs = (await call(a.guiPort, '/api/requests?limit=5')).json;
  assert.equal(logs[0].status, 200);
  assert.equal(logs[0].input_tokens + logs[0].output_tokens, 18);
  assert.equal(logs[0].req_body, undefined);

  // The relay's database must not contain the prompt, the reply or the upstream key.
  const dbFiles = fs.readdirSync(relayDir).filter((f) => f.startsWith('relay.db'));
  const dbBytes = Buffer.concat(dbFiles.map((f) => fs.readFileSync(path.join(relayDir, f))));
  for (const secret of ['TOPSECRET_PROMPT', 'TOPSECRET_REPLY', 'sk-upstream-secret']) {
    assert.equal(dbBytes.includes(Buffer.from(secret)), false, `relay stored ${secret}`);
  }

  await call(a.guiPort, `/api/shares/${share.id}`, {
    method: 'PATCH', body: { dailyTokenLimit: 10 },
  });
  const blocked = await fetch(`http://127.0.0.1:${b.proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${share.key}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(blocked.status, 429);

  const openai = (await call(a.guiPort, '/api/providers', {
    method: 'POST',
    body: {
      name: 'gpt',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      apiKey: 'sk-upstream-openai',
    },
  })).json;
  const chatShare = (await call(a.guiPort, '/api/shares', {
    method: 'POST',
    body: {
      providerId: openai.id, consumerId: bMe.id, name: 'codex', dailyTokenLimit: 5000,
    },
  })).json;

  const stream = await fetch(`http://127.0.0.1:${b.proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${chatShare.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [] }),
  });
  assert.equal(stream.status, 200);
  const streamText = await stream.text();
  assert.match(streamText, /"content":"hi"/);
  assert.match(streamText, /\[DONE\]/);
  assert.equal(JSON.parse(seen.chat.body).stream_options.include_usage, true);
  assert.equal(seen.chat.headers.authorization, 'Bearer sk-upstream-openai');

  const chatLogs = (await call(a.guiPort, `/api/requests?shareId=${chatShare.id}`)).json;
  assert.equal(chatLogs[0].input_tokens + chatLogs[0].output_tokens, 10);

  // Owner closes the client: consumer gets a clear 503 instead of hanging.
  a.close();
  await waitFor(async () => (await call(b.guiPort, '/api/peers')).json[0].online === false);
  const offline = await fetch(`http://127.0.0.1:${b.proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${chatShare.key}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(offline.status, 503);
});

test('pair code is single use and expires', async (t) => {
  const dir = tmpDir('pair');
  const relay = await startServer({
    port: 0, host: '127.0.0.1', dataDir: dir, secret: 'test-secret', pairTtlMs: 200,
  });
  const base = `http://127.0.0.1:${relay.port}`;
  t.after(() => {
    relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const idA = await createIdentity();
  const idB = await createIdentity();
  const reg = async (name, pubKey) => (await (await fetch(base + '/api/onboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pubKey }),
  })).json());
  const a = await reg('A', idA.pub);
  const b = await reg('B', idB.pub);

  const pair = await (await fetch(base + '/api/pair/code', {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
  })).json();
  const redeem = await fetch(base + '/api/pair/redeem', {
    method: 'POST',
    headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pair.code }),
  });
  assert.equal(redeem.status, 200);

  const again = await fetch(base + '/api/pair/redeem', {
    method: 'POST',
    headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pair.code }),
  });
  assert.equal(again.status, 400);

  const pair2 = await (await fetch(base + '/api/pair/code', {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
  })).json();
  await sleep(260);
  const expired = await fetch(base + '/api/pair/redeem', {
    method: 'POST',
    headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pair2.code }),
  });
  assert.equal(expired.status, 400);
});
