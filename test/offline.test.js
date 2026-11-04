const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const captions = require('../lib/captions');
const frames = require('../lib/ble-frame');
const ble = require('../lib/feishu-ble');
const CaptionSocket = require('../lib/caption-socket');

function transcript(revision = 0, final = false, text = 'Hello') {
  return { type: 'transcript', segmentId: 'one', revision, text, language: 'en', final };
}
function translation(sourceRevision = 0, revision = 0, final = false, text = '你好') {
  return { type: 'translation', segmentId: 'one', sourceRevision, revision, text, language: 'zh', final };
}
function packet(type, id, payload = [], tx = false) {
  const body = [tx ? 8 : 9, tx ? 238 : 255, 0, 0, tx ? 0 : 1, type, id, (payload.length + 10) & 255, (payload.length + 10) >> 8, ...payload];
  return [...body, body.reduce((sum, value) => (sum + value) & 255, 0)];
}
const target = { deviceId: 'selected-device', serviceId: ble.SERVICE, characteristicId: ble.WRITER };

test('revised recognition clears the old translation and rejects its late updates', () => {
  let state = captions.reduce(captions.createState(), transcript());
  state = captions.reduce(state, translation());
  assert.equal(state.segments[0].translation, '你好');
  state = captions.reduce(state, transcript(1, true, 'Hello everyone'));
  assert.equal(state.segments[0].translation, '');
  assert.strictEqual(captions.reduce(state, translation(0, 1, true)), state);
  state = captions.reduce(state, translation(1, 0, true, '大家好'));
  assert.equal(state.segments[0].translation, '大家好');
});

test('stale and partial events cannot overwrite a finalized transcript or translation', () => {
  let state = captions.reduce(captions.createState(), transcript(2, true));
  assert.strictEqual(captions.reduce(state, transcript(1, true, 'old')), state);
  assert.strictEqual(captions.reduce(state, transcript(3, false, 'late partial')), state);
  state = captions.reduce(state, translation(2, 0, true));
  assert.strictEqual(captions.reduce(state, translation(2, 1, false)), state);
});

test('caption input bounds prevent malformed or unbounded UI state', () => {
  let state = captions.createState();
  assert.throws(() => captions.reduce(state, transcript(NaN)), /Invalid/);
  assert.throws(() => captions.reduce(state, transcript(0, false, 'x'.repeat(2001))), /Invalid/);
  assert.throws(() => captions.reduce(state, translation(undefined, -1)), /Invalid/);
  for (let i = 0; i < 100; i++) state = captions.reduce(state, { ...transcript(), segmentId: String(i) });
  assert.equal(state.segments.length, captions.MAX_SEGMENTS);
  assert.equal(state.segments[0].id, '20');
});

test('device-info read uses exactly 20 unprefixed hex characters for its 10-byte frame', () => {
  assert.deepEqual(frames.readDeviceInfo(), [8, 238, 0, 0, 0, 1, 1, 10, 0, 2]);
  const value = frames.prepareWrite(frames.readDeviceInfo());
  assert.equal(value, '08ee00000001010a0002');
  assert.equal(value.length, 20);
  assert.match(value, /^(?:[0-9a-f]{2})+$/);
  assert.equal(frames.toHex(frames.readDeviceInfo()), '0x08ee00000001010a0002');
});

test('75-byte public-key exchange is rejected before any platform write', () => {
  const frame = frames.ephemeralPublicKey([4, ...Array(64).fill(1)]);
  let writes = 0;
  assert.equal(frame.length, 75);
  assert.throws(() => ble.writeFrame({ writeBLECharacteristicValue() { writes++; } }, target, frame), error => error.code === 'FEISHU_WRITE_LIMIT' && error.frameBytes === 75);
  assert.equal(writes, 0);
});

test('binding, reset, recording, deletion and unknown commands cannot be written', () => {
  for (const [type, id, payload] of [[11, 135, [1]], [1, 184, []], [24, 130, [1]], [26, 16, [0, 0, 0, 0]], [255, 255, []]]) {
    assert.throws(() => frames.prepareWrite(packet(type, id, payload, true)), /allowlist/);
  }
});

test('inbound notification fragments and concatenated packets reassemble with checksums', () => {
  const one = packet(1, 1, [1, 2, 3]);
  const two = packet(26, 8, [4, 5, 6, 7]);
  const decoder = new frames.FrameDecoder();
  assert.deepEqual(decoder.push([77, 88, ...one.slice(0, 3)]), []);
  assert.deepEqual(decoder.push(frames.toHex([...one.slice(3), ...two])), [
    { type: 1, id: 1, status: 1, payload: [1, 2, 3] },
    { type: 26, id: 8, status: 1, payload: [4, 5, 6, 7] }
  ]);
});

test('checksum failures resynchronize without emitting corrupted data', () => {
  const corrupted = packet(1, 1, [1]);
  corrupted[10] ^= 1;
  const decoder = new frames.FrameDecoder();
  assert.equal(decoder.push([...corrupted, ...packet(1, 1)]).length, 1);
  assert.equal(decoder.invalidFrames, 1);
});

test('invalid hex, impossible lengths and oversized receive buffers fail safely', () => {
  for (const value of ['0x1', 'GG', '', '0x0g']) assert.throws(() => frames.fromHex(value), /Invalid/);
  const decoder = new frames.FrameDecoder();
  assert.equal(decoder.push([9, 255, 0, 0, 1, 1, 1, 0, 0, 0, ...packet(1, 1)]).length, 1);
  assert.throws(() => decoder.push(Array(131071).fill(0)), /buffer limit/);
  assert.deepEqual(decoder.buffer, []);
});

test('only the selected device and expected notifier reach the parser', () => {
  const decoder = new frames.FrameDecoder();
  const event = { deviceId: target.deviceId, serviceId: ble.SERVICE, characteristicId: ble.NOTIFIER, value: frames.toHex(packet(1, 1)) };
  assert.deepEqual(ble.notificationFrames(decoder, 'different-device', event), []);
  assert.deepEqual(ble.notificationFrames(decoder, target.deviceId, { ...event, characteristicId: ble.WRITER }), []);
  assert.equal(ble.notificationFrames(decoder, target.deviceId, event).length, 1);
});

test('write adapter uses verified Feishu fields and propagates failures', async () => {
  let received;
  await ble.writeFrame({ writeBLECharacteristicValue(options) { received = options; options.success({ errMsg: 'ok' }); } }, target, frames.readDeviceInfo());
  assert.equal(received.value, '08ee00000001010a0002');
  assert.equal(received.value.length, 20);
  assert.equal(received.deviceId, target.deviceId);
  await assert.rejects(ble.writeFrame({ writeBLECharacteristicValue(options) { options.fail({ errCode: 10006 }); } }, target, frames.readDeviceInfo()), error => error.code === 10006);
  assert.throws(() => ble.writeFrame({}, { ...target, serviceId: 'unrelated' }, frames.readDeviceInfo()), /D3200/);
});

function socketFixture() {
  const hooks = {};
  const events = [];
  const calls = [];
  const task = {
    onOpen(fn) { hooks.open = fn; },
    onMessage(fn) { hooks.message = fn; },
    onClose(fn) { hooks.close = fn; },
    close(value) { calls.push(['close', value]); }
  };
  const api = { connectSocket(options) { calls.push(['connect', options]); return task; } };
  const client = new CaptionSocket(api, {
    gatewayHost: 'private.example.invalid', url: 'wss://private.example.invalid/captions',
    sessionToken: 'local-test-token-only', onEvent(event) { events.push(event); }
  });
  return { client, hooks, calls, events };
}

test('socket construction is inert; explicit connect uses the authorization header', () => {
  const fixture = socketFixture();
  assert.equal(fixture.calls.length, 0);
  fixture.client.connect();
  try {
    assert.equal(fixture.calls[0][1].header.Authorization, 'Bearer local-test-token-only');
    fixture.hooks.open();
    fixture.hooks.message({ data: JSON.stringify(transcript()) });
    assert.equal(fixture.events.length, 1);
  } finally { fixture.client.disconnect(); }
});

test('background close clears the active socket without reconnecting', () => {
  const fixture = socketFixture();
  fixture.client.connect();
  fixture.hooks.open();
  fixture.hooks.close({ closeType: '2' });
  assert.equal(fixture.client.status, 'background');
  assert.equal(fixture.client.task, null);
  assert.equal(fixture.calls.filter(call => call[0] === 'connect').length, 1);
});

test('late events from a closed socket cannot mutate captions', () => {
  const fixture = socketFixture();
  fixture.client.connect();
  fixture.hooks.open();
  fixture.client.disconnect();
  fixture.hooks.message({ data: JSON.stringify(transcript()) });
  assert.equal(fixture.events.length, 0);
});

test('invalid gateway messages stop the session', () => {
  const fixture = socketFixture();
  fixture.client.connect();
  fixture.hooks.open();
  fixture.hooks.message({ data: 'not-json' });
  assert.equal(fixture.client.status, 'invalid_message');
  assert.equal(fixture.client.task, null);
});

test('gateway URL query credentials and non-WSS URLs are rejected before connection', () => {
  const fixture = socketFixture();
  fixture.client.options.url = 'ws://private.example.invalid/captions';
  assert.throws(() => fixture.client.connect(), /explicit WSS/);
  fixture.client.options.url = 'wss://private.example.invalid/captions?key=secret';
  assert.throws(() => fixture.client.connect(), /explicit WSS/);
  assert.equal(fixture.calls.length, 0);
});

test('synchronous platform failures leave no active socket or timeout', () => {
  const fixture = socketFixture();
  fixture.client.api.connectSocket = () => { throw new Error('host unavailable'); };
  assert.throws(() => fixture.client.connect(), /creation failed/);
  assert.equal(fixture.client.status, 'failed');
  assert.equal(fixture.client.task, null);
  assert.equal(fixture.client.timeout, null);
});

test('synchronous platform fail callback closes any returned task once', () => {
  const fixture = socketFixture();
  fixture.client.api.connectSocket = options => {
    options.fail({ errCode: 1 });
    return { close() { fixture.calls.push(['close']); } };
  };
  fixture.client.connect();
  assert.equal(fixture.client.status, 'failed');
  assert.equal(fixture.client.task, null);
  assert.equal(fixture.calls.length, 1);
});

test('default native page starts empty without requesting platform access or recording', async () => {
  let definition;
  const store = require('../lib/recording-store');
  const sandbox = {
    Page(value) { definition = value; },
    require(value) { if (value.endsWith('recording-store')) return store; throw new Error('Unexpected import'); },
    getApp() { return { minutesStore: { async list() { return []; } } }; },
    setTimeout() { throw new Error('Unexpected startup timer'); },
    tt: new Proxy({}, { get() { throw new Error('Unexpected platform access'); } }),
    fetch() { throw new Error('Unexpected network access'); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/index/index.js'), 'utf8'), sandbox);
  const page = { ...definition, data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch); } };
  await page.onLoad();
  assert.equal(page.data.view, 'library');
  assert.equal(page.data.records.length, 0);
  assert.equal(page.data.rows.length, 0);
  assert.equal(page.data.running, false);
  assert.equal(page.data.connected, false);
  assert.equal(page.captureId, null);
  assert.match(page.data.runtimeStatus, /尚未接入/);
});
