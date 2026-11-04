/* D3200 protocol crypto, WebCrypto only. No device, storage, network or recording APIs.
 * The device echoes the shared value; this checks protocol consistency, not identity.
 * AES-CTR is unauthenticated: BLE checksum/known header do not provide an AEAD tag.
 */
var binary = require('./binary');
var MARKER = binary.utf8Encode('soundcored3200');
function fail(code, message) { var error = new Error(message); error.code = code; return error; }
function copy(value) { return new Uint8Array(binary.bytes(value)); }
function u32(data, offset) { return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true); }
function equal(a, b) {
  if (a.length !== b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function D3200Crypto(provider) {
  this.provider = provider || (typeof globalThis !== 'undefined' && globalThis.crypto);
  if (!this.provider || !this.provider.subtle) throw fail('WEBCRYPTO_UNAVAILABLE', 'WebCrypto requires a supported secure context');
  this.epoch = 0;
  this.state = 'new';
  this.privateKey = this.sessionKey = this.fileKey = this.fileNonce = null;
  this.fileId = null;
}
D3200Crypto.prototype.check = function (epoch) {
  if (this.epoch !== epoch || this.state === 'destroyed') throw fail('CANCELLED', 'Crypto operation cancelled');
};
D3200Crypto.prototype.createPublicKey = async function () {
  if (this.state !== 'new') throw fail('CRYPTO_STATE', 'Ephemeral key already created');
  this.state = 'creating';
  var epoch = this.epoch;
  var pair = await this.provider.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  this.check(epoch);
  var publicKey = new Uint8Array(await this.provider.subtle.exportKey('raw', pair.publicKey));
  this.check(epoch);
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw fail('CRYPTO_LAYOUT', 'Unexpected public-key encoding');
  this.privateKey = pair.privateKey;
  this.state = 'awaiting_peer';
  return publicKey;
};
D3200Crypto.prototype.acceptHandshake = async function (value) {
  if (this.state !== 'awaiting_peer') throw fail('CRYPTO_STATE', 'No pending ephemeral exchange');
  var data = copy(value), epoch = this.epoch, shared;
  if (data.length !== 97 || data[0] !== 4) throw fail('CRYPTO_LAYOUT', 'Unexpected 97-byte handshake response');
  this.state = 'verifying_peer';
  try {
    var peer = await this.provider.subtle.importKey('raw', data.subarray(0, 65), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    this.check(epoch);
    shared = new Uint8Array(await this.provider.subtle.deriveBits({ name: 'ECDH', public: peer }, this.privateKey, 256));
    this.check(epoch);
    if (!equal(shared, data.subarray(65))) throw fail('SHARED_VALUE_MISMATCH', 'Device shared value did not match');
    var input = await this.provider.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    this.check(epoch);
    var session = await this.provider.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
      salt: new Uint8Array([1, 2, 3]), info: new Uint8Array([1, 2, 3]) }, input,
      { name: 'AES-CTR', length: 256 }, false, ['decrypt']);
    this.check(epoch);
    this.sessionKey = session;
    this.privateKey = null;
    this.state = 'session_ready';
    return { sharedValueMatched: true, peerIdentityAuthenticated: false };
  } catch (error) {
    this.privateKey = this.sessionKey = null;
    if (this.state !== 'destroyed') this.state = 'failed';
    if (error.code) throw error;
    throw fail('KEY_EXCHANGE_FAILED', 'Device public-key exchange failed');
  } finally { data.fill(0); if (shared) shared.fill(0); }
};
D3200Crypto.prototype.acceptAudioHeader = async function (value, expectedFileId) {
  if (this.state !== 'session_ready') throw fail('CRYPTO_STATE', 'File header requires a verified session');
  var data = copy(value), epoch = this.epoch, plain;
  if (data.length !== 87 || !Number.isInteger(expectedFileId) || expectedFileId < 1 || u32(data, 0) !== expectedFileId) {
    throw fail('AUDIO_HEADER_LAYOUT', 'Unexpected file ID or 87-byte audio header');
  }
  if (data[86] !== 0) throw fail('AUDIO_HEADER_REJECTED', 'Device rejected the audio transfer');
  try {
    plain = new Uint8Array(await this.provider.subtle.decrypt({ name: 'AES-CTR', counter: data.slice(70, 86), length: 128 },
      this.sessionKey, data.slice(24, 70)));
    this.check(epoch);
    if (plain.length !== 46 || !equal(plain.subarray(0, 14), MARKER)) throw fail('FILE_KEY_MISMATCH', 'Audio file-key marker did not match');
    var key = await this.provider.subtle.importKey('raw', plain.subarray(14), { name: 'AES-CTR' }, false, ['decrypt']);
    this.check(epoch);
    this.fileKey = key;
    this.fileNonce = data.slice(8, 24);
    this.fileId = expectedFileId;
    this.state = 'file_ready';
    return { fileId: expectedFileId, reportedFileBytes: u32(data, 4), fileKeyVerified: true, authenticatedEncryption: false };
  } catch (error) {
    this.fileKey = this.fileNonce = null;
    if (error.code) throw error;
    throw fail('FILE_KEY_FAILED', 'Audio file key could not be decrypted');
  } finally { data.fill(0); if (plain) plain.fill(0); }
};
D3200Crypto.prototype.decryptSlice = async function (value) {
  if (this.state !== 'file_ready') throw fail('CRYPTO_STATE', 'Audio arrived before a verified file key');
  var data = copy(value), epoch = this.epoch;
  if (data.length !== 166) throw fail('AUDIO_SLICE_LENGTH', 'D3200 audio slice must contain 166 bytes');
  var sequence = u32(data, 0);
  // Every packet consumes ten AES blocks. Never allow the low 32-bit counter to wrap.
  if (sequence > Math.floor((0xffffffff - 9) / 10)) throw fail('AUDIO_COUNTER_RANGE', 'Audio counter would overflow');
  var counter = new Uint8Array(16);
  counter.set(this.fileNonce.subarray(0, 12));
  new DataView(counter.buffer).setUint32(12, sequence * 10, false);
  var plain = new Uint8Array(await this.provider.subtle.decrypt({ name: 'AES-CTR', counter: counter, length: 32 }, this.fileKey, data.subarray(5, 165)));
  this.check(epoch);
  if (plain.length !== 160) throw fail('AUDIO_PLAINTEXT_LENGTH', 'Expected a complete 160-byte Opus packet');
  return { fileId: this.fileId, sequence: sequence, opus: plain, durationMs: 20, offsetMs: sequence * 20,
    codec: 'opus', decoded: false };
};
D3200Crypto.prototype.destroy = function () {
  this.epoch++;
  this.privateKey = this.sessionKey = this.fileKey = null;
  if (this.fileNonce) this.fileNonce.fill(0);
  this.fileNonce = null;
  this.fileId = null;
  this.state = 'destroyed';
};
module.exports = D3200Crypto;
