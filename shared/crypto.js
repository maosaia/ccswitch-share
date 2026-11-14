'use strict';

const crypto = require('node:crypto');

const { subtle } = crypto.webcrypto;
const text = new TextEncoder();
const ALGO = { name: 'ECDH', namedCurve: 'P-256' };

async function createIdentity() {
  const pair = await subtle.generateKey(ALGO, true, ['deriveBits']);
  const pub = await subtle.exportKey('jwk', pair.publicKey);
  const priv = await subtle.exportKey('jwk', pair.privateKey);
  return {
    pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
    priv: { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d },
  };
}

// ECDH on both sides yields the same secret; HKDF only needs to be deterministic.
async function deriveKey(privJwk, peerPubJwk) {
  const priv = await subtle.importKey('jwk', privJwk, ALGO, false, ['deriveBits']);
  const pub = await subtle.importKey('jwk', peerPubJwk, ALGO, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: text.encode('ccswitch-share'), info: text.encode('pair-v1') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key, buf) {
  const iv = crypto.randomBytes(12);
  const ct = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, key, buf));
  return Buffer.concat([iv, ct]).toString('base64');
}

async function open(key, b64) {
  const b = Buffer.from(b64, 'base64');
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12));
  return Buffer.from(pt);
}

module.exports = { createIdentity, deriveKey, seal, open };
