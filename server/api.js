'use strict';

const crypto = require('node:crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(16).toString('hex');

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function fail(res, status, message) {
  send(res, status, { error: message });
}

function bearer(h) {
  const m = /^Bearer\s+(.+)$/i.exec(h || '');
  return m ? m[1].trim() : '';
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

function dayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function createApi({ db, cipher, codes, attempts, pairTtlMs, isOnline }) {
  const usageToday = (shareId) =>
    db.prepare(
      'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM requests WHERE share_id = ? AND created_at >= ?',
    ).get(shareId, dayStart()).t;

  const seriesFor = (shareId, days = 7) => {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = dayStart(Date.now() - i * 86400000);
      const row = db.prepare(
        'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM requests WHERE share_id = ? AND created_at >= ? AND created_at < ?',
      ).get(shareId, start, start + 86400000);
      out.push({ date: localDate(start), tokens: row.t });
    }
    return out;
  };

  const serializeShare = (row) => {
    const consumer = db.prepare('SELECT id, name FROM members WHERE id = ?').get(row.consumer_id);
    return {
      id: row.id,
      name: row.name,
      provider: { id: row.provider_id, name: row.provider_name, protocol: row.protocol },
      consumer: consumer ? { ...consumer, online: isOnline(consumer.id) } : null,
      dailyTokenLimit: row.daily_token_limit,
      enabled: !!row.enabled,
      usageToday: usageToday(row.id),
      series: seriesFor(row.id),
      createdAt: row.created_at,
      key: cipher.dec(row.key_enc),
    };
  };

  const peersOf = (memberId) =>
    db.prepare(
      'SELECT m.id, m.name, m.pub_key FROM links l JOIN members m ON m.id = l.b WHERE l.a = ? ORDER BY m.name',
    ).all(memberId).map((p) => ({
      id: p.id,
      name: p.name,
      pubKey: JSON.parse(p.pub_key),
      online: isOnline(p.id),
    }));

  const memberFor = (req) => {
    const token = bearer(req.headers.authorization);
    return token ? db.prepare('SELECT id, name, pub_key FROM members WHERE token_hash = ?').get(sha256(token)) : null;
  };

  return async function apiRoute(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const resource = parts[1] || '';
    const sub = parts[2] || '';

    if (req.method === 'POST' && resource === 'onboard') {
      const { name, pubKey } = await readJson(req);
      const clean = String(name || '').trim().slice(0, 40);
      if (!clean) return fail(res, 400, '昵称不能为空');
      if (!pubKey || pubKey.kty !== 'EC' || pubKey.crv !== 'P-256' || !pubKey.x || !pubKey.y) {
        return fail(res, 400, '缺少有效的设备公钥');
      }
      const token = crypto.randomBytes(32).toString('hex');
      const id = newId();
      const pub = JSON.stringify({ kty: pubKey.kty, crv: pubKey.crv, x: pubKey.x, y: pubKey.y });
      db.prepare('INSERT INTO members(id, name, token_hash, pub_key, created_at) VALUES(?,?,?,?,?)')
        .run(id, clean, sha256(token), pub, Date.now());
      return send(res, 200, { memberId: id, name: clean, token });
    }

    const me = memberFor(req);
    if (!me) return fail(res, 401, '未登录');

    if (resource === 'me' && req.method === 'GET') {
      return send(res, 200, { id: me.id, name: me.name, pubKey: JSON.parse(me.pub_key) });
    }

    if (resource === 'shares') {
      if (req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM shares WHERE owner_id = ? ORDER BY created_at').all(me.id);
        return send(res, 200, rows.map(serializeShare));
      }
      if (req.method === 'POST') {
        const b = await readJson(req);
        const consumerId = String(b.consumerId || '');
        if (!consumerId || !db.prepare('SELECT 1 FROM links WHERE a = ? AND b = ?').get(me.id, consumerId)) {
          return fail(res, 400, '请先配对再开共享通道');
        }
        const protocol = b.protocol === 'openai' ? 'openai' : b.protocol === 'anthropic' ? 'anthropic' : '';
        if (!protocol) return fail(res, 400, '协议不合法');
        const providerId = String(b.providerId || '');
        if (!providerId) return fail(res, 400, '缺少本机供应商');
        const providerName = String(b.providerName || 'API').slice(0, 40);
        const limit = Math.max(0, Math.floor(Number(b.dailyTokenLimit) || 0));
        if (!limit) return fail(res, 400, '日限额必须大于 0');
        const key = 'sk-share-' + crypto.randomBytes(16).toString('hex');
        const id = newId();
        const name = String(b.name || '').trim().slice(0, 40) || '共享通道';
        db.prepare(
          `INSERT INTO shares(id, owner_id, consumer_id, provider_id, provider_name, protocol,
            key_hash, key_enc, daily_token_limit, enabled, created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?)`,
        ).run(id, me.id, consumerId, providerId, providerName, protocol, sha256(key), cipher.enc(key), limit, Date.now());
        return send(res, 200, serializeShare(db.prepare('SELECT * FROM shares WHERE id = ?').get(id)));
      }
      if (sub && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const own = db.prepare('SELECT * FROM shares WHERE id = ? AND owner_id = ?').get(sub, me.id);
        if (!own) return fail(res, 404, '共享不存在');
        if (req.method === 'DELETE') {
          db.prepare('DELETE FROM shares WHERE id = ?').run(sub);
          return send(res, 200, { ok: true });
        }
        const b = await readJson(req);
        const limit = b.dailyTokenLimit === undefined
          ? own.daily_token_limit
          : Math.max(0, Math.floor(Number(b.dailyTokenLimit) || 0));
        if (!limit) return fail(res, 400, '日限额必须大于 0');
        const enabled = b.enabled === undefined ? own.enabled : (b.enabled ? 1 : 0);
        db.prepare('UPDATE shares SET daily_token_limit=?, enabled=? WHERE id=?').run(limit, enabled, sub);
        return send(res, 200, serializeShare(db.prepare('SELECT * FROM shares WHERE id = ?').get(sub)));
      }
    }

    if (resource === 'pair') {
      if (req.method === 'GET') {
        let active = null;
        for (const [code, entry] of codes) {
          if (entry.by === me.id && entry.expiresAt > Date.now()) active = { code, expiresAt: entry.expiresAt };
        }
        return send(res, 200, { peers: peersOf(me.id), code: active });
      }
      if (sub === 'code' && req.method === 'POST') {
        for (const [code, entry] of codes) {
          if (entry.by === me.id && entry.expiresAt > Date.now()) {
            return send(res, 200, { code, expiresAt: entry.expiresAt });
          }
        }
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        const expiresAt = Date.now() + pairTtlMs;
        codes.set(code, { by: me.id, expiresAt });
        return send(res, 200, { code, expiresAt });
      }
      if (sub === 'redeem' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || '?';
        const now = Date.now();
        const hits = (attempts.get(ip) || []).filter((t) => now - t < 60000);
        if (hits.length >= 5) return fail(res, 429, '尝试太频繁，请稍后再试');
        attempts.set(ip, [...hits, now]);
        const { code } = await readJson(req);
        const entry = codes.get(String(code || ''));
        if (!entry || entry.expiresAt <= now) return fail(res, 400, '验证码无效或已过期');
        if (entry.by === me.id) return fail(res, 400, '不能兑换自己生成的验证码');
        const peer = db.prepare('SELECT id, name, pub_key FROM members WHERE id = ?').get(entry.by);
        if (!peer) return fail(res, 400, '对方已不存在');
        db.prepare('INSERT OR IGNORE INTO links(a, b, created_at) VALUES(?,?,?)').run(me.id, peer.id, now);
        db.prepare('INSERT OR IGNORE INTO links(a, b, created_at) VALUES(?,?,?)').run(peer.id, me.id, now);
        codes.delete(String(code));
        return send(res, 200, { peer: { id: peer.id, name: peer.name, pubKey: JSON.parse(peer.pub_key) } });
      }
    }

    if (resource === 'peers' && req.method === 'GET') {
      const out = peersOf(me.id).map((p) => {
        const shares = db.prepare(
          'SELECT * FROM shares WHERE owner_id = ? AND consumer_id = ? AND enabled = 1',
        ).all(p.id, me.id);
        return { ...p, shares: shares.map(serializeShare) };
      });
      return send(res, 200, out);
    }

    if (resource === 'requests' && req.method === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const shareId = url.searchParams.get('shareId');
      const args = [me.id, me.id];
      let sql = 'SELECT * FROM requests WHERE (owner_id = ? OR consumer_id = ?)';
      if (shareId) {
        sql += ' AND share_id = ?';
        args.push(shareId);
      }
      sql += ' ORDER BY id DESC LIMIT ?';
      args.push(limit);
      return send(res, 200, db.prepare(sql).all(...args));
    }

    return fail(res, 404, 'not found');
  };
}

module.exports = { createApi };
