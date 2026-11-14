'use strict';

const { meterFromText } = require('../shared/usage');

const HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
  'accept-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer',
  'authorization', 'x-api-key',
]);
const HEAD_CAP = 200 * 1024;

function pickHeaders(incoming, provider, protocol) {
  const out = {};
  for (const [k, v] of Object.entries(incoming || {})) {
    if (!HOP.has(k)) out[k] = v;
  }
  if (incoming && incoming['x-api-key']) out['x-api-key'] = provider.apiKey;
  else out.authorization = 'Bearer ' + provider.apiKey;
  if (protocol === 'anthropic' && !out['anthropic-version']) out['anthropic-version'] = '2023-06-01';
  return out;
}

function responseHeaders(headers) {
  const out = {};
  headers.forEach((v, k) => {
    if (!HOP.has(k) && k !== 'content-encoding') out[k] = v;
  });
  return out;
}

// Calls the provider with the owner's key and streams the response to the consumer.
async function forwardRequest({
  provider, protocol, method = 'POST', fullPath, search, headers, bodyBuf, onStart, onChunk,
}) {
  const outHeaders = pickHeaders(headers, provider, protocol);
  let outBody = bodyBuf;
  let bodyJson = null;
  try {
    bodyJson = JSON.parse(bodyBuf.toString('utf8'));
  } catch {}
  if (bodyJson && bodyJson.stream && fullPath.includes('/chat/completions')) {
    bodyJson.stream_options = { ...(bodyJson.stream_options || {}), include_usage: true };
    outBody = Buffer.from(JSON.stringify(bodyJson));
  }

  const base = provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const upstream = await fetch(base + fullPath + (search || ''), {
    method,
    headers: outHeaders,
    body: outBody.length && method !== 'GET' && method !== 'HEAD' ? outBody : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });

  await onStart(upstream.status, responseHeaders(upstream.headers));

  let head = '';
  let tail = '';
  const dec = new TextDecoder();
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await onChunk(Buffer.from(value));
      const text = dec.decode(value, { stream: true });
      if (head.length < HEAD_CAP) head += text.slice(0, HEAD_CAP - head.length);
      tail = (tail + text).slice(-8192);
    }
  }

  const a = meterFromText(head);
  const b = meterFromText(tail);
  const u = a && b
    ? { input: Math.max(a.input, b.input), output: Math.max(a.output, b.output) }
    : a || b;
  const reqLen = bodyBuf.length;
  const respLen = head.length;
  return {
    status: upstream.status,
    model: bodyJson ? bodyJson.model : null,
    input: u ? u.input : Math.ceil((reqLen + respLen) / 4),
    output: u ? u.output : 0,
    estimated: u ? 0 : 1,
  };
}

module.exports = { forwardRequest };
