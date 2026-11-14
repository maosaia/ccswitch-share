'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createIdentity, deriveKey, seal, open } = require('./crypto');

test('two identities derive the same key and round-trip', async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const ka = await deriveKey(a.priv, b.pub);
  const kb = await deriveKey(b.priv, a.pub);
  const sealed = await seal(ka, Buffer.from('hello 世界'));
  assert.equal((await open(kb, sealed)).toString(), 'hello 世界');
  assert.equal((await open(ka, sealed)).toString(), 'hello 世界');
});

test('wrong key cannot open', async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const c = await createIdentity();
  const ab = await deriveKey(a.priv, b.pub);
  const ac = await deriveKey(a.priv, c.pub);
  const sealed = await seal(ab, Buffer.from('secret'));
  await assert.rejects(() => open(ac, sealed));
});
