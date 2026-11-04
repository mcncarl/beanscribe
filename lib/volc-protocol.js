/* Volcengine bigmodel_async protocol v1, verified against official docs and
 * official Python protocol.py downloaded 2026-10-28. Network-independent.
 */
var binary = require('./binary');
var gzip = require('./gzip');
var MAX_PAYLOAD = 1024 * 1024;
var ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
var RESOURCE_ID = 'volc.seedasr.sauc.duration';

function positiveSequence(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid positive protocol sequence');
  return value;
}

function compressionCode(value) {
  if (value === undefined || value === 'gzip') return 1;
  if (value === 'none') return 0;
  throw new Error('Unsupported request compression');
}

function requestFrame(type, serialization, payload, sequence, last, compression) {
  positiveSequence(sequence);
  var source = binary.bytes(payload);
  if (source.length > MAX_PAYLOAD) throw new Error('Request payload limit exceeded');
  var compressed = compression ? gzip.compress(source) : source;
  if (compressed.length > MAX_PAYLOAD) throw new Error('Compressed payload limit exceeded');
  var data = new Uint8Array(12 + compressed.length);
  data.set([0x11, (type << 4) | (last ? 3 : 1), (serialization << 4) | compression, 0]);
  var view = new DataView(data.buffer);
  view.setInt32(4, last ? -sequence : sequence, false);
  view.setUint32(8, compressed.length, false);
  data.set(compressed, 12);
  return data;
}

function createOggRequest(options) {
  options = options || {};
  // Current standalone docs list ogg but omit codec in their parameter table;
  // the unified official docs explicitly require opus. Make this choice visible.
  if (!['explicit-opus', 'omit-current-table'].includes(options.codecMode)) throw new Error('Choose an explicit documented codec mode');
  var audio = { format: 'ogg', rate: 16000, bits: 16, channel: 1 };
  if (options.codecMode === 'explicit-opus') audio.codec = 'opus';
  return {
    audio: audio,
    request: { model_name: 'bigmodel', enable_nonstream: true, show_utterances: true, enable_itn: true, enable_punc: true }
  };
}

function encodeFullRequest(request, sequence, compression) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !request.audio || !request.request) throw new Error('Invalid ASR request configuration');
  return requestFrame(1, 1, binary.utf8Encode(JSON.stringify(request)), sequence === undefined ? 1 : sequence, false, compressionCode(compression));
}

function encodeAudio(value, sequence, last, compression) {
  if (typeof last !== 'boolean') throw new Error('Specify whether this is the last audio package');
  // Current official Python new_audio_only_request retains its default JSON
  // serialization flag, while the actual payload is raw audio (then gzip).
  // Match that reference byte-for-byte; do not JSON/base64-encode audio data.
  return requestFrame(2, 1, value, sequence, last, compressionCode(compression));
}

function decodeServerMessage(value) {
  var data = binary.bytes(value);
  if (data.length < 8 || data.length > MAX_PAYLOAD + 80) throw new Error('Invalid server message length');
  var version = data[0] >> 4, headerBytes = (data[0] & 15) * 4;
  var type = data[1] >> 4, flags = data[1] & 15;
  var serialization = data[2] >> 4, compression = data[2] & 15;
  if (version !== 1 || headerBytes < 4 || headerBytes > data.length || data[3] !== 0) throw new Error('Unsupported server protocol header');
  if (![9, 15].includes(type) || (flags & 8) || ![0, 1].includes(serialization) || ![0, 1].includes(compression)) throw new Error('Unsupported server message encoding');
  var view = new DataView(data.buffer, data.byteOffset, data.byteLength), offset = headerBytes;
  function read(signed) {
    if (offset + 4 > data.length) throw new Error('Truncated server protocol fields');
    var result = signed ? view.getInt32(offset, false) : view.getUint32(offset, false);
    offset += 4; return result;
  }
  var sequence = null, event = null, code = 0;
  if (flags & 1) {
    sequence = read(true);
    if ((flags & 2) ? sequence >= 0 : sequence <= 0) throw new Error('Server sequence sign conflicts with final flag');
  }
  // Flag 0x4 is present in the current official Python response parser.
  if (flags & 4) event = read(true);
  if (type === 15) code = read(true);
  var payloadSize = read(false);
  if (payloadSize > MAX_PAYLOAD || offset + payloadSize !== data.length) throw new Error('Server payload size mismatch');
  var payloadBytes = data.subarray(offset);
  if (compression) payloadBytes = gzip.decompress(payloadBytes, MAX_PAYLOAD);
  var payload;
  if (serialization === 1) {
    if (!payloadBytes.length) throw new Error('Empty JSON server response');
    payload = JSON.parse(binary.utf8Decode(payloadBytes));
    if (payload === null || typeof payload !== 'object') throw new Error('Invalid JSON server response');
  } else payload = binary.utf8Decode(payloadBytes);
  return { type: type === 15 ? 'error' : 'result', code: code, event: event, sequence: sequence, final: !!(flags & 2), payload: payload, payloadBytes: payloadSize, compression: compression ? 'gzip' : 'none' };
}

module.exports = {
  ENDPOINT: ENDPOINT, RESOURCE_ID: RESOURCE_ID, MAX_PAYLOAD: MAX_PAYLOAD,
  createOggRequest: createOggRequest, encodeFullRequest: encodeFullRequest,
  encodeAudio: encodeAudio, decodeServerMessage: decodeServerMessage
};
