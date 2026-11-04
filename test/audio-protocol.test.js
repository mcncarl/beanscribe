const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const binary = require('../lib/binary');
const gzip = require('../lib/gzip');
const { OggOpusMuxer, opusPacketInfo, crc32Ogg } = require('../lib/ogg-opus');
const protocol = require('../lib/volc-protocol');
const VolcAsrClient = require('../lib/volc-socket');

function readPage(page) {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  assert.equal(Buffer.from(page.subarray(0, 4)).toString(), 'OggS');
  const copy = new Uint8Array(page);
  const crc = view.getUint32(22, true);
  copy.fill(0, 22, 26);
  assert.equal(crc32Ogg(copy), crc);
  const count = page[26], lacing = [...page.subarray(27, 27 + count)];
  assert.equal(27 + count + lacing.reduce((a, b) => a + b, 0), page.length);
  const low = view.getUint32(6, true), high = view.getUint32(10, true);
  return { flags: page[5], granule: high === 0xffffffff && low === 0xffffffff ? -1 : high * 4294967296 + low,
    serial: view.getUint32(14, true), sequence: view.getUint32(18, true), lacing, body: page.subarray(27 + count) };
}
function mux(options = {}) { return new OggOpusMuxer({ serial: 0x10203040, preSkip: 0, ...options }); }
function packet(length = 160) { const p = new Uint8Array(length); p[0] = 8; return p; }

test('portable UTF-8 agrees with Node for Chinese and supplementary characters', () => {
  const text = '中英 captions 🌏 𠮷';
  assert.deepEqual(Buffer.from(binary.utf8Encode(text)), Buffer.from(text));
  assert.equal(binary.utf8Decode(Buffer.from(text)), text);
  for (const invalid of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0xb8]]) {
    assert.throws(() => binary.utf8Decode(invalid), /UTF-8/);
  }
});

test('Opus headers specify mapping, sample-rate metadata, pre-skip and separate tags', () => {
  assert.throws(() => new OggOpusMuxer({ serial: 1 }), /pre-skip/);
  const stream = mux({ preSkip: 312, vendor: '本地 test' });
  const headers = stream.headers().map(readPage);
  assert.equal(headers.length, 2);
  assert.deepEqual(headers.map(x => [x.sequence, x.flags, x.granule]), [[0, 2, 0], [1, 0, 0]]);
  assert.equal(Buffer.from(headers[0].body.subarray(0, 8)).toString(), 'OpusHead');
  assert.equal(headers[0].body.length, 19);
  const view = new DataView(headers[0].body.buffer, headers[0].body.byteOffset, headers[0].body.length);
  assert.equal(view.getUint16(10, true), 312);
  assert.equal(view.getUint32(12, true), 16000);
  assert.equal(headers[0].body[18], 0);
  assert.equal(Buffer.from(headers[1].body.subarray(0, 8)).toString(), 'OpusTags');
  assert.equal(Buffer.from(headers[1].body.subarray(12, -4)).toString(), '本地 test');
});

test('lacing terminates multiples of 255 and preserves every zero byte', () => {
  const stream = mux(); stream.headers();
  const one = packet(255), two = packet(510);
  assert.deepEqual(stream.push(one), []);
  const first = readPage(stream.push(two)[0]);
  const last = readPage(stream.finish()[0]);
  assert.deepEqual(first.lacing, [255, 0]);
  assert.deepEqual(last.lacing, [255, 255, 0]);
  assert.deepEqual(first.body, one);
  assert.deepEqual(last.body, two);
  assert.equal(first.granule, 960);
  assert.equal(last.granule, 1920);
  assert.equal(last.flags, 4);
});

test('large legal Opus padding crosses pages with continuation and -1 granule', () => {
  // Code 3, one 2.5 ms DTX frame and explicit Opus-layer padding (RFC 6716).
  const big = new Uint8Array(70000);
  big.set([0x83, 0x41]); big.fill(255, 2, 276); big[276] = 127;
  assert.equal(opusPacketInfo(big).samples48k, 120);
  const stream = mux(); stream.headers(); stream.push(big);
  const pages = stream.finish().map(readPage);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].flags, 0);
  assert.equal(pages[0].granule, -1);
  assert.equal(pages[0].lacing.length, 255);
  assert.equal(pages[1].flags, 5);
  assert.equal(pages[1].granule, 120);
  assert.deepEqual(binary.concat(pages.map(x => x.body)), big);
});

test('Opus TOC durations use 48 kHz independently of input sample-rate metadata', () => {
  for (const [toc, samples] of [[0, 480], [8, 960], [16, 1920], [24, 2880], [104, 960], [128, 120], [248, 960]]) {
    assert.equal(opusPacketInfo([toc, 0]).samples48k, samples);
  }
  assert.equal(opusPacketInfo([0xfb, 6, 0, 0, 0, 0, 0, 0]).samples48k, 5760);
  for (const bad of [[], [9, 0], [10], [0xfb, 0], [0xfb, 7, 0, 0, 0, 0, 0, 0, 0], [0xfb, 65, 5, 0], [0xfb, 130, 255]]) {
    assert.throws(() => opusPacketInfo(bad), /Opus/);
  }
});

test('pre-skip and end trim are explicit and EOS cannot be emitted twice', () => {
  const stream = mux({ preSkip: 312 }); stream.headers();
  stream.push(packet()); stream.push(packet());
  assert.equal(readPage(stream.finish(240)[0]).granule, 1680);
  assert.throws(() => stream.finish(), /pending/);
  assert.throws(() => stream.push(packet()), /not open/);
  const empty = mux(); empty.headers(); assert.throws(() => empty.finish(), /pending/);
  const short = mux({ preSkip: 1000 }); short.headers(); short.push(packet());
  assert.throws(() => short.finish(), /pre-skip/);
});

test('vendored gzip interoperates with zlib and validates footer checksum and limits', () => {
  const original = Buffer.from('中英文实时识别 '.repeat(100));
  assert.deepEqual(zlib.gunzipSync(gzip.compress(original)), original);
  assert.deepEqual(Buffer.from(gzip.decompress(zlib.gzipSync(original))), original);
  const corrupt = new Uint8Array(zlib.gzipSync(original)); corrupt[corrupt.length - 8] ^= 1;
  assert.throws(() => gzip.decompress(corrupt), /checksum/);
  assert.throws(() => gzip.decompress(zlib.gzipSync(original), 20), /limit/);
  const forgedSize = new Uint8Array(zlib.gzipSync(original));
  new DataView(forgedSize.buffer).setUint32(forgedSize.length - 4, 1, true);
  assert.throws(() => gzip.decompress(forgedSize), /limit/);
});

test('gzip rejects duplicate members and garbage before a copied trailer', () => {
  const single = zlib.gzipSync(Buffer.from('hello'));
  assert.equal(single.length, 25);
  assert.throws(() => gzip.decompress(Buffer.concat([single, single])), /Trailing/);
  assert.throws(() => gzip.decompress(Buffer.concat([single, Buffer.from([7, 8, 9]), single.subarray(-8)])), /Trailing/);
});

test('gzip consumes complete stored, fixed and dynamic DEFLATE streams across chunks', () => {
  const content = Buffer.from(Array.from({ length: 20000 }, (_, i) => String.fromCharCode(32 + ((i * 19 + Math.floor(i / 91)) % 95))).join(''));
  for (const options of [{ level: 0 }, { level: 6, strategy: zlib.constants.Z_FIXED }, { level: 9 }]) {
    const compressed = zlib.gzipSync(content, options);
    assert.deepEqual(Buffer.from(gzip.decompress(compressed)), content);
  }
});

test('gzip validates optional header fields and their CRC', () => {
  const original = zlib.gzipSync(Buffer.from('payload'));
  const header = Buffer.concat([original.subarray(0, 10), Buffer.from([2, 0, 11, 12]), Buffer.from('file\0comment\0')]);
  header[3] = 4 | 8 | 16 | 2;
  const headerCrc = Buffer.alloc(2); headerCrc.writeUInt16LE(gzip.crc32(header) & 65535);
  const customized = Buffer.concat([header, headerCrc, original.subarray(10)]);
  assert.equal(gzip.decompress(customized).length, 7);
  assert.equal(zlib.gunzipSync(customized).toString(), 'payload');
  customized[header.length] ^= 1;
  assert.throws(() => gzip.decompress(customized), /header checksum/);
});

function serverFrame(payload, options = {}) {
  const type = options.errorCode === undefined ? 9 : 15;
  const flags = options.flags === undefined ? (options.final ? 3 : 1) : options.flags;
  const compression = options.compression === undefined ? 1 : options.compression;
  const serialization = options.serialization === undefined ? 1 : options.serialization;
  const body = serialization === 1 ? Buffer.from(JSON.stringify(payload)) : Buffer.from(payload);
  const encoded = compression === 1 ? zlib.gzipSync(body) : body;
  const fields = [];
  function field(value, signed) { const b = Buffer.alloc(4); signed ? b.writeInt32BE(value) : b.writeUInt32BE(value); fields.push(b); }
  if (flags & 1) field(options.sequence === undefined ? (options.final ? -3 : 1) : options.sequence, true);
  if (flags & 4) field(options.event === undefined ? 7 : options.event, true);
  if (type === 15) field(options.errorCode, true);
  field(encoded.length, false);
  return Buffer.concat([Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | compression, 0]), ...fields, encoded]);
}

test('request configuration makes codec-document differences explicit', () => {
  assert.throws(() => protocol.createOggRequest(), /codec mode/);
  const explicit = protocol.createOggRequest({ codecMode: 'explicit-opus' });
  assert.equal(explicit.audio.format, 'ogg'); assert.equal(explicit.audio.codec, 'opus');
  assert.equal(explicit.request.enable_nonstream, true);
  assert.equal(protocol.createOggRequest({ codecMode: 'omit-current-table' }).audio.codec, undefined);
});

test('full-request and final-audio headers match official big-endian sequence protocol', () => {
  const request = protocol.createOggRequest({ codecMode: 'explicit-opus' });
  const frame = Buffer.from(protocol.encodeFullRequest(request));
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x11, 0x11, 0]);
  assert.equal(frame.readInt32BE(4), 1);
  assert.equal(frame.readUInt32BE(8), frame.length - 12);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(frame.subarray(12)).toString()), request);
  const audio = Buffer.from(protocol.encodeAudio([79, 103, 103, 83], 2, true, 'none'));
  assert.deepEqual([...audio.subarray(0, 4)], [0x11, 0x23, 0x10, 0]);
  assert.equal(audio.readInt32BE(4), -2);
  assert.equal(audio.readUInt32BE(8), 4);
  assert.equal(audio.subarray(12).toString(), 'OggS');
});

test('gzip results, final responses, raw errors and event fields decode correctly', () => {
  const response = protocol.decodeServerMessage(serverFrame({ result: { text: '你好 hello' } }, { final: true }));
  assert.equal(response.payload.result.text, '你好 hello'); assert.equal(response.sequence, -3); assert.equal(response.final, true);
  const error = protocol.decodeServerMessage(serverFrame('invalid audio', { errorCode: 45000001, flags: 0, serialization: 0, compression: 0 }));
  assert.equal(error.type, 'error'); assert.equal(error.code, 45000001); assert.equal(error.payload, 'invalid audio');
  assert.equal(protocol.decodeServerMessage(serverFrame({}, { flags: 5, event: 17 })).event, 17);
});

test('malformed protocol headers, truncated fields and false payload sizes are rejected', () => {
  const valid = serverFrame({ result: {} }, { compression: 0 });
  for (const corrupt of [valid.subarray(0, 3), valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])])]) {
    assert.throws(() => protocol.decodeServerMessage(corrupt));
  }
  const wrongVersion = Buffer.from(valid); wrongVersion[0] = 0x21;
  assert.throws(() => protocol.decodeServerMessage(wrongVersion), /header/);
  assert.throws(() => protocol.decodeServerMessage(serverFrame({}, { final: true, sequence: 2 })), /sign/);
  const badGzip = Buffer.from(serverFrame({})); badGzip[badGzip.length - 8] ^= 1;
  assert.throws(() => protocol.decodeServerMessage(badGzip), /checksum/);
});

function fakeClient() {
  const sent = [], hooks = {}, connections = [], timers = new Map(), statuses = [];
  let timerId = 0, closes = 0;
  const task = {
    onOpen(fn) { hooks.open = fn; }, onMessage(fn) { hooks.message = fn; }, onClose(fn) { hooks.close = fn; },
    send(options) { sent.push(options); }, close() { closes++; }
  };
  const client = new VolcAsrClient({ connectSocket(options) { connections.push(options); return task; } }, {
    clock: { setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } },
    onStatus(status) { statuses.push(status); }
  });
  const auth = { apiKey: 'test-runtime-credential', requestId: '12345678-1234-4234-8234-123456789012', codecMode: 'explicit-opus' };
  async function ready() {
    const promise = client.start(auth);
    hooks.open();
    sent[0].success();
    hooks.message({ data: binary.arrayBuffer(serverFrame({ result: { text: '' } })) });
    await promise;
  }
  return { client, sent, hooks, connections, timers, statuses, auth, ready, get closes() { return closes; } };
}

test('native client is inert until explicit start and keeps keys out of client state', async () => {
  const f = fakeClient(); assert.equal(f.connections.length, 0);
  await f.ready();
  assert.equal(f.connections[0].url, protocol.ENDPOINT);
  assert.equal(f.connections[0].header['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
  assert.equal(f.connections[0].header['X-Api-Key'], f.auth.apiKey);
  assert.equal(JSON.stringify(f.client).includes(f.auth.apiKey), false);
  f.client.cancel(); assert.equal(f.timers.size, 0);
});

test('native send queue preserves order; finish waits for service final text', async () => {
  const f = fakeClient(); await f.ready();
  const first = f.client.sendAudio([1]);
  const second = f.client.sendAudio([2]);
  const finish = f.client.finish([3]);
  assert.equal(f.sent.length, 2);
  f.sent[1].success(); await first; assert.equal(f.sent.length, 3);
  f.sent[2].success(); await second; assert.equal(f.sent.length, 4);
  f.sent[3].success(); assert.equal(f.client.status, 'awaiting_final');
  assert.deepEqual(f.sent.slice(1).map(x => new DataView(x.data).getInt32(4, false)), [2, 3, -4]);
  f.hooks.message({ data: binary.arrayBuffer(serverFrame({ result: { text: '测试 hello' } }, { final: true, sequence: -4 })) });
  assert.equal((await finish).payload.result.text, '测试 hello');
  assert.equal(f.client.status, 'completed'); assert.equal(f.closes, 1); assert.equal(f.timers.size, 0);
});

test('provider errors reject configuration and never start audio', async () => {
  const f = fakeClient();
  const pending = f.client.start(f.auth);
  const rejected = assert.rejects(pending, error => error.code === 'PROVIDER_ERROR' && error.providerCode === 45000001);
  f.hooks.open(); f.sent[0].success();
  f.hooks.message({ data: binary.arrayBuffer(serverFrame({ message: 'invalid format' }, { errorCode: 45000001, flags: 0 })) });
  await rejected; assert.equal(f.client.status, 'failed'); assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 0);
});

test('background interruption rejects pending writes and finalization without retry', async () => {
  const f = fakeClient(); await f.ready();
  const audio = assert.rejects(f.client.sendAudio([1]), error => error.code === 'BACKGROUND');
  const final = assert.rejects(f.client.finish([2]), error => error.code === 'BACKGROUND');
  f.hooks.close({ closeType: '2' });
  await Promise.all([audio, final]);
  assert.equal(f.client.status, 'background'); assert.equal(f.connections.length, 1); assert.equal(f.timers.size, 0);
});

test('empty final response and missing final response do not become successful sessions', async () => {
  const f = fakeClient(); await f.ready();
  const empty = assert.rejects(f.client.finish([1]), error => error.code === 'NO_FINAL_TEXT');
  f.sent[1].success();
  f.hooks.message({ data: binary.arrayBuffer(serverFrame({ result: { text: '' } }, { final: true })) });
  await empty; assert.equal(f.client.status, 'failed');
  const g = fakeClient(); await g.ready();
  const missing = assert.rejects(g.client.finish([1]), error => error.code === 'FINAL_TIMEOUT');
  g.sent[1].success();
  const finalTimer = [...g.timers.values()].find(x => x.ms === 10000);
  finalTimer.fn(); await missing; assert.equal(g.client.status, 'failed');
});

test('malformed compressed responses fail the native client and late messages are ignored', async () => {
  const f = fakeClient(); await f.ready();
  const broken = serverFrame({}); broken[broken.length - 8] ^= 1;
  f.hooks.message({ data: binary.arrayBuffer(broken) });
  assert.equal(f.client.status, 'failed');
  f.hooks.message({ data: binary.arrayBuffer(serverFrame({ result: { text: 'late' } })) });
  assert.equal(f.client.status, 'failed'); assert.equal(f.timers.size, 0);
});

test('send timeout and queue overflow release transport with explicit failure', async () => {
  const f = fakeClient(); await f.ready();
  const pending = assert.rejects(f.client.sendAudio([1]), error => error.code === 'SEND_TIMEOUT');
  [...f.timers.values()].find(x => x.ms === 10000).fn();
  await pending; assert.equal(f.client.status, 'failed');
  const g = fakeClient(); await g.ready();
  // Disable compression in this fixture to test the byte bound predictably.
  g.client.compression = 'none';
  const pendingWrites = [];
  for (let i = 0; i < 9; i++) pendingWrites.push(g.client.sendAudio(new Uint8Array(65536)).catch(error => error.code));
  const codes = await Promise.all(pendingWrites);
  assert.ok(codes.includes('BACKPRESSURE'));
  assert.equal(g.client.status, 'failed'); assert.equal(g.timers.size, 0);
});
