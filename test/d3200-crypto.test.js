const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const D3200Crypto = require('../lib/d3200-crypto');
const { vector, provider, hex } = require('./d3200-fixture.cjs');
async function ready() {
  const crypto = new D3200Crypto(provider());
  assert.deepEqual(await crypto.createPublicKey(), hex(vector.client_public_hex));
  await crypto.acceptHandshake(hex(vector.handshake_hex));
  return crypto;
}
test('Python cryptography ECDH/HKDF/AES-CTR oracle decrypts every byte including trailing zeros', async () => {
  const crypto = await ready();
  assert.equal(crypto.sessionKey.extractable, false);
  const header = await crypto.acceptAudioHeader(hex(vector.header_hex), vector.file_id);
  assert.equal(header.reportedFileBytes, 498);
  const frames = [];
  for (let sequence = 0; sequence < vector.packet_count; sequence++) {
    const frame = await crypto.decryptSlice(hex(vector.slices_hex[sequence]));
    assert.equal(frame.sequence, sequence);
    assert.equal(frame.offsetMs, sequence * 20);
    assert.equal(frame.opus.length, 160);
    assert.deepEqual(frame.opus, hex(vector.plain_hex[sequence]));
    assert.equal(frame.opus[159], 0);
    frames.push(Buffer.from(frame.opus));
  }
  assert.equal(createHash('sha256').update(Buffer.concat(frames)).digest('hex'), vector.plain_sha256);
  crypto.destroy();
});
test('mismatched echoed shared value and invalid public point fail without a session key', async () => {
  for (const corrupt of ['shared', 'point']) {
    const crypto = new D3200Crypto(provider()); await crypto.createPublicKey();
    const response = hex(vector.handshake_hex);
    if (corrupt === 'shared') response[96] ^= 1; else response.fill(0, 1, 65);
    await assert.rejects(crypto.acceptHandshake(response), error => ['SHARED_VALUE_MISMATCH', 'KEY_EXCHANGE_FAILED'].includes(error.code));
    assert.equal(crypto.sessionKey, null); assert.equal(crypto.privateKey, null);
  }
});
test('file header identity, device error and known plaintext marker are enforced', async () => {
  for (const kind of ['id', 'error', 'marker', 'length']) {
    const crypto = await ready();
    const header = hex(vector.header_hex);
    if (kind === 'error') header[86] = 1;
    if (kind === 'marker') header[24] ^= 1;
    await assert.rejects(crypto.acceptAudioHeader(kind === 'length' ? header.slice(0, 86) : header, kind === 'id' ? 999 : vector.file_id));
    assert.equal(crypto.fileKey, null); crypto.destroy();
  }
});
test('audio cannot precede header, use a short slice, or wrap the 32-bit AES counter', async () => {
  const crypto = await ready();
  await assert.rejects(crypto.decryptSlice(hex(vector.slices_hex[0])), /before a verified/);
  await crypto.acceptAudioHeader(hex(vector.header_hex), vector.file_id);
  await assert.rejects(crypto.decryptSlice(new Uint8Array(165)), /166/);
  const overflow = hex(vector.slices_hex[0]); new DataView(overflow.buffer).setUint32(0, 0xffffffff, true);
  await assert.rejects(crypto.decryptSlice(overflow), error => error.code === 'AUDIO_COUNTER_RANGE');
  crypto.destroy(); await assert.rejects(crypto.decryptSlice(hex(vector.slices_hex[0])), /before a verified/);
});
test('cancelled WebCrypto key generation cannot restore key references', async () => {
  let release; const normal = provider();
  const crypto = new D3200Crypto({ subtle: new Proxy(normal.subtle, { get(target, key) {
    if (key === 'generateKey') return () => new Promise(resolve => { release = async () => resolve(await target.generateKey()); });
    return target[key];
  } }) });
  const pending = crypto.createPublicKey(); crypto.destroy(); await release();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(crypto.privateKey, null); assert.equal(crypto.state, 'destroyed');
});
test('browser bundle exposes constructors without CommonJS or platform side effects', () => {
  const context = { window: {}, globalThis: {}, Uint8Array, ArrayBuffer, DataView, WeakMap, Map, Set, Promise, Number };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../h5/d3200-bundle.js'), 'utf8'), context);
  assert.equal(typeof context.window.D3200Session, 'function');
  assert.equal(typeof context.window.D3200Crypto, 'function');
});
