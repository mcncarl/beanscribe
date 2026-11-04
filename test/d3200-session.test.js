const test = require('node:test');
const assert = require('node:assert/strict');
const D3200Session = require('../lib/d3200-session');
const wire = require('../lib/ble-frame');
const { vector, provider, hex, mockApi, ticks } = require('./d3200-fixture.cjs');
const testSessions = new Set();
test.afterEach(async () => {
  // Failed assertions must also release watcher timers so the runner can exit.
  const sessions = Array.from(testSessions);
  testSessions.clear();
  await Promise.allSettled(sessions.map(session => session.disconnect()));
});
function fixture(options = {}, apiOptions = {}) {
  const mock = mockApi(apiOptions), states = [], frames = [], errors = [], ends = [];
  const session = new D3200Session(mock.api, { crypto: provider(), capabilities: { maxWriteBytes: 75 },
    apiTimeoutMs: 500, ackTimeoutMs: 500, pollIntervalMs: 100,
    onState: state => states.push(state), onFrame: frame => frames.push(frame), onError: error => errors.push(error), onEnd: end => ends.push(end), ...options });
  testSessions.add(session);
  return { ...mock, session, states, frames, errors, ends };
}
async function connected(options, apiOptions) { const f = fixture(options, apiOptions); await f.session.connect({ deviceId: 'bean' }); return f; }
function slices(indices = [0, 1, 2]) { return new Uint8Array(Buffer.concat(indices.map(i => Buffer.from(vector.slices_hex[i], 'hex')))); }

test('constructor is inert, scan filters candidates and does not auto-connect', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  const startDiscovery = f.api.startBluetoothDevicesDiscovery;
  f.api.startBluetoothDevicesDiscovery = args => {
    startDiscovery(args);
    f.hooks.found({ devices: [{ deviceId: 'bean', name: 'soundcore Work', RSSI: -55 }, { deviceId: 'other', name: 'headphones' }] });
  };
  const devices = await f.session.scan({ durationMs: 25 });
  assert.equal(devices.length, 1); assert.equal(devices[0].deviceId, 'bean');
  assert.equal(f.calls.some(c => c.name === 'connectBLEDevice'), false);
  assert.equal(f.hooks.found, undefined);
  await f.session.disconnect();
});
test('scan recovers cached and service-scoped connected peripherals without a new discovery event', async () => {
  const diagnostics = [], f = fixture({ onDiagnostic: event => diagnostics.push(event) });
  f.api.getBluetoothDevices = args => args.success({ devices: [
    { deviceId: 'cached-bean', localName: 'my recorder', advertisServiceUUIDs: ['020CF5DA'] },
    { deviceId: 'headphones', name: 'soundcore headphones' },
    { deviceId: 'private-unrelated-device', name: 'other' }
  ] });
  f.api.getConnectedBluetoothDevices = args => {
    assert.deepEqual(args.services, ['020cf5da-0000-1000-8000-00805f9b34fb']);
    args.success({ devices: [{ deviceId: 'connected-bean', name: 'renamed recorder' }] });
  };
  const devices = await f.session.scan({ durationMs: 1 });
  assert.deepEqual(devices.map(x => x.deviceId), ['cached-bean', 'connected-bean']);
  assert.deepEqual(devices.map(x => x.discoverySource), ['cached', 'connected']);
  assert.equal(f.calls.some(c => c.name === 'connectBLEDevice'), false);
  assert.deepEqual(diagnostics, [{ type: 'scan_complete', eventCount: 0, advertisedCount: 0,
    cachedCount: 3, connectedCount: 1, matchedCount: 2 }]);
  assert.equal(JSON.stringify(diagnostics).includes('recorder'), false);
  assert.equal(JSON.stringify(diagnostics).includes('deviceId'), false);
  await f.session.disconnect();
});
test('failed optional device snapshots retain fresh candidates and report the exact API code', async () => {
  const diagnostics = [], f = fixture({ onDiagnostic: event => diagnostics.push(event) });
  f.api.startBluetoothDevicesDiscovery = args => {
    args.success({}); f.hooks.found({ devices: [{ deviceId: 'bean', name: 'soundcore Work' }] });
  };
  f.api.getBluetoothDevices = args => args.fail({ errCode: 10004 });
  f.api.getConnectedBluetoothDevices = args => args.success({ devices: [{ deviceId: 'bean', name: 'same device' }] });
  const devices = await f.session.scan({ durationMs: 1 });
  assert.equal(devices.length, 1); assert.equal(devices[0].discoverySource, 'advertisement');
  assert.deepEqual(diagnostics[0], { type: 'scan_lookup_failed', api: 'getBluetoothDevices', code: 'BLE_API_FAILED', platformCode: 10004 });
  assert.equal(diagnostics[1].matchedCount, 1);
  await f.session.disconnect();
});
test('documented 20-byte default remains closed; explicit 75-byte capability sends one full frame', async () => {
  const f = fixture({ capabilities: {} });
  await assert.rejects(f.session.connect({ deviceId: 'bean' }), e => e.code === 'FEISHU_WRITE_LIMIT');
  await f.session.disconnect();
  assert.equal(f.calls.filter(c => c.name === 'writeBLECharacteristicValue').length, 1);
  const good = await connected();
  const writes = good.calls.filter(c => c.name === 'writeBLECharacteristicValue');
  assert.equal(writes.length, 2); assert.equal(writes[1].args.value.length, 150);
  assert.match(writes[1].args.value, /^[0-9a-f]{150}$/);
  assert.equal(good.session.transportCapability.deviceValidated, true);
  await good.session.disconnect();
});
test('iOS short UUID identifiers are validated then reused exactly for characteristic access and writes', async () => {
  const f = fixture();
  f.api.getBLEDeviceServices = args => args.success({ services: [{ serviceId: '020CF5DA' }] });
  f.api.getBLEDeviceCharacteristics = args => {
    assert.equal(args.serviceId, '020CF5DA');
    args.success({ characteristics: [
      { characteristicId: '7777', properties: { write: true } },
      { characteristicId: '8888', properties: { notify: true } }
    ] });
  };
  const write = f.api.writeBLECharacteristicValue, notify = f.api.notifyBLECharacteristicValueChange;
  f.api.writeBLECharacteristicValue = args => {
    assert.equal(args.serviceId, '020CF5DA'); assert.equal(args.characteristicId, '7777'); write(args);
  };
  f.api.notifyBLECharacteristicValueChange = args => {
    assert.equal(args.serviceId, '020CF5DA'); assert.equal(args.characteristicId, '8888'); notify(args);
  };
  const onValue = f.api.onBLECharacteristicValueChange;
  f.api.onBLECharacteristicValueChange = fn => onValue(event => fn({ ...event, serviceId: '020CF5DA', characteristicId: '8888' }));
  const result = await f.session.connect({ deviceId: 'bean' });
  assert.equal(result.cryptoReady, true);
  await f.session.disconnect();
});
test('platform write success never advances handshake without actual device ACKs', async () => {
  const f = fixture({}, { manualAck: true });
  const connection = f.session.connect({ deviceId: 'bean' }); await ticks();
  assert.equal(f.session.state, 'awaiting_info');
  assert.equal(f.session._crypto, null);
  f.event(1, 1, Array(55).fill(0)); await ticks();
  assert.equal(f.session.state, 'awaiting_key');
  f.event(46, 1, hex(vector.handshake_hex));
  await connection; assert.equal(f.session.state, 'crypto_ready');
  await f.session.disconnect();
});
test('device auth diagnostics distinguish present flags, missing tail, and non-binary bytes', async () => {
  const cases = [
    { length: 62, raw: [], expected: [null, null] },
    { length: 63, raw: [1], expected: [true, null] },
    { length: 64, raw: [0, 1], expected: [false, true] },
    { length: 64, raw: [2, 255], expected: [null, null] }
  ];
  for (const example of cases) {
    const diagnostics = [], f = fixture({ onDiagnostic: event => { if (event.type === 'device_info_capability') diagnostics.push(event); } }, { manualAck: true });
    const pending = f.session.connect({ deviceId: 'bean' }); await ticks();
    const payload = Array(example.length).fill(0);
    example.raw.forEach((value, index) => { payload[62 + index] = value; });
    f.event(1, 1, payload); await ticks();
    f.event(46, 1, hex(vector.handshake_hex));
    const connected = await pending;
    assert.deepEqual([connected.deviceInfo.supportAuth, connected.deviceInfo.hasAuthUid], example.expected);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].deviceInfoBytes, example.length);
    assert.equal(diagnostics[0].supportAuthRaw, example.raw[0] ?? null);
    assert.equal(diagnostics[0].hasAuthUidRaw, example.raw[1] ?? null);
    assert.equal('firmware' in diagnostics[0], false);
    assert.equal('payload' in diagnostics[0], false);
    await f.session.disconnect();
  }
});
test('replay metadata and ordered drain preserve all already-received frames', async () => {
  let release; const received = [];
  const f = await connected({ onFrame: async frame => {
    received.push(frame);
    if (frame.sequence === 0) await new Promise(resolve => { release = resolve; });
  } });
  const result = await f.session.readFile(vector.file_id);
  assert.equal(result.sourceType, 'device_recorded_file_replay');
  f.event(26, 8, slices()); await ticks();
  assert.equal(received.length, 1);
  let settled = false;
  const stopped = f.session.stop({ drain: true }).then(result => { settled = true; return result; });
  f.event(26, 8, slices()); await ticks(); assert.equal(settled, false);
  release(); const summary = await stopped;
  assert.deepEqual(received.map(x => x.sequence), [0, 1, 2]);
  assert.ok(received.every(x => x.opus.length === 160 && x.opus[159] === 0 && x.sourceType === 'device_recorded_file_replay'));
  assert.equal(summary.audioFrames, 3); assert.equal(summary.drained, true);
  assert.equal(f.session._crypto.sessionKey, null); assert.equal(f.hooks.value, undefined);
});
test('startLive only lists and reads an existing active recording; no record-control command', async () => {
  const f = await connected();
  await f.session.startLive();
  const commands = f.calls.filter(x => x.name === 'writeBLECharacteristicValue').map(x => wire.fromHex(x.args.value));
  assert.deepEqual(commands.map(x => [x[5], x[6]]), [[1, 1], [46, 1], [26, 14], [46, 1], [26, 7]]);
  assert.equal(commands[4][17], 1); assert.equal(f.session.mode, 'live');
  await f.session.disconnect();
});
test('no current recording waits for physical action and cancel clears polling', async () => {
  const f = await connected({}, { activeFile: false });
  const ready = f.session.startLive(); await ticks();
  assert.equal(f.session.state, 'waiting_for_recording');
  assert.equal(f.calls.filter(x => x.name === 'writeBLECharacteristicValue').length, 3);
  await f.session.disconnect(); await assert.rejects(ready, e => e.code === 'CANCELLED');
  assert.equal(f.session._timers.size, 0);
});
test('physical start replaces a stale waiting-session key before delivering audio', async () => {
  const { webcrypto } = require('node:crypto');
  const f = await connected({ pollIntervalMs: 60000 }, { activeFile: false });
  const started = f.session.startLive(); await ticks();
  const prior = f.session._crypto;
  prior.sessionKey = await webcrypto.subtle.importKey('raw', new Uint8Array(32), 'AES-CTR', false, ['decrypt']);
  const active = new Uint8Array(4); new DataView(active.buffer).setUint32(0, vector.file_id, true);
  f.event(26, 6, active);
  await started;
  f.event(26, 8, slices()); await ticks();
  assert.equal(prior.state, 'destroyed'); assert.equal(prior.sessionKey, null);
  assert.deepEqual(f.frames.map(x => x.sequence), [0, 1, 2]);
  assert.deepEqual(f.frames[0].opus, hex(vector.plain_hex[0]));
  assert.equal(f.errors.length, 0);
  await f.session.disconnect();
});
test('invalid refreshed key response stops before requesting any audio', async () => {
  const f = await connected(), write = f.api.writeBLECharacteristicValue;
  f.api.writeBLECharacteristicValue = args => {
    const frame = wire.fromHex(args.value);
    if (frame[5] !== 46) return write(args);
    f.calls.push({ name: 'writeBLECharacteristicValue', args }); args.success({});
    const wrong = hex(vector.handshake_hex); wrong[96] ^= 1;
    queueMicrotask(() => f.event(46, 1, wrong));
  };
  await assert.rejects(f.session.readFile(vector.file_id), e => e.code === 'SHARED_VALUE_MISMATCH');
  assert.equal(f.calls.some(c => c.args && c.args.value && wire.fromHex(c.args.value)[6] === 7), false);
  assert.equal(f.frames.length, 0); await f.session.disconnect();
});
test('cancelling a pending transfer key exchange prevents a late ACK from starting audio', async () => {
  const f = await connected(), write = f.api.writeBLECharacteristicValue;
  f.api.writeBLECharacteristicValue = args => {
    if (wire.fromHex(args.value)[5] !== 46) return write(args);
    f.calls.push({ name: 'writeBLECharacteristicValue', args }); args.success({});
  };
  const started = f.session.readFile(vector.file_id); await ticks();
  assert.equal(f.session.state, 'awaiting_key');
  await f.session.disconnect();
  f.event(46, 1, hex(vector.handshake_hex)); await ticks();
  await assert.rejects(started, e => e.code === 'CANCELLED');
  assert.equal(f.calls.some(c => c.args && c.args.value && wire.fromHex(c.args.value)[6] === 7), false);
  assert.equal(f.frames.length, 0);
});
test('file_done emits onEnd only after all queued async frame deliveries', async () => {
  let release; const delivered = [];
  const f = await connected({ onFrame: async frame => { delivered.push(frame.sequence); if (!frame.sequence) await new Promise(r => { release = r; }); } });
  await f.session.readFile(vector.file_id);
  f.event(26, 8, slices()); f.event(26, 10, []); await ticks();
  assert.equal(f.ends.length, 0); assert.deepEqual(delivered, [0]);
  release(); await ticks();
  assert.deepEqual(delivered, [0, 1, 2]); assert.equal(f.ends.length, 1);
  assert.equal(f.ends[0].reason, 'file_done'); assert.equal(f.ends[0].audioFrames, 3);
  assert.equal(f.session.state, 'completed');
});
test('duplicate slices are suppressed; sequence gap fails before forwarding corrupt continuity', async () => {
  const f = await connected(); await f.session.readFile(vector.file_id);
  f.event(26, 8, slices([0, 0, 2])); await ticks();
  assert.deepEqual(f.frames.map(x => x.sequence), [0]);
  assert.equal(f.session.stats.duplicates, 1); assert.equal(f.session.stats.sequenceGaps, 1);
  assert.equal(f.errors[0].code, 'AUDIO_SEQUENCE_GAP'); await f.session.disconnect();
});
test('file end cannot claim an empty or truncated replay completed', async () => {
  for (const count of [0, 1]) {
    const f = await connected(); await f.session.readFile(vector.file_id);
    if (count) f.event(26, 8, slices([0]));
    f.event(26, 10, []); await ticks();
    assert.equal(f.ends.length, 0);
    assert.equal(f.errors[0].code, count ? 'INCOMPLETE_REPLAY' : 'EMPTY_AUDIO');
    await f.session.disconnect();
  }
});
test('wrong device notifications are ignored and receive queue overload fails closed', async () => {
  let release;
  const f = await connected({ maxQueuedBytes: 350, onFrame: () => new Promise(r => { release = r; }) });
  await f.session.readFile(vector.file_id);
  f.event(26, 8, slices([0]), 1, { deviceId: 'unselected' }); await ticks(); assert.equal(f.session.stats.audioFrames, 0);
  f.event(26, 8, slices([0])); await ticks();
  f.event(26, 8, slices([1, 2])); await ticks();
  assert.equal(f.errors[0].code, 'AUDIO_QUEUE_OVERFLOW');
  release(); await f.session.disconnect(); await ticks();
  assert.equal(f.session.stats.audioFrames, 0); assert.equal(f.session._queue.length, 0); assert.equal(f.session._queuedBytes, 0);
});
test('native disconnect cancels pending session and old callbacks cannot restart it', async () => {
  const f = await connected(); const oldNotification = f.hooks.value;
  f.hooks.connection({ deviceId: 'bean', connected: false }); await ticks();
  assert.equal(f.errors[0].code, 'DEVICE_DISCONNECTED');
  const count = f.calls.filter(x => x.name === 'writeBLECharacteristicValue').length;
  oldNotification({ deviceId: 'bean', value: '09ff0000011a060e00010000002d' }); await ticks();
  assert.equal(f.calls.filter(x => x.name === 'writeBLECharacteristicValue').length, count);
  assert.equal(f.session._crypto.sessionKey, null); await f.session.disconnect();
});
test('late successful connect after cancel is disconnected without advancing handshake', async () => {
  const f = fixture({}, { holdConnect: true });
  const connection = f.session.connect({ deviceId: 'bean' }); await ticks();
  await f.session.disconnect(); await assert.rejects(connection, e => e.code === 'CANCELLED');
  f.held.connect.success({}); await ticks();
  assert.equal(f.calls.filter(x => x.name === 'writeBLECharacteristicValue').length, 0);
  assert.ok(f.calls.filter(x => x.name === 'disconnectBLEDevice').length >= 2);
  assert.equal(f.session.state, 'stopped');
});
test('ACK rejection, ACK timeout and platform write failure propagate as failures', async () => {
  const rejected = fixture({}, { manualAck: true });
  const pending = rejected.session.connect({ deviceId: 'bean' }); await ticks();
  rejected.event(1, 1, [], 2);
  await assert.rejects(pending, e => e.code === 'DEVICE_ACK_REJECTED'); await rejected.session.disconnect();
  const timed = fixture({ ackTimeoutMs: 5 }, { manualAck: true });
  await assert.rejects(timed.session.connect({ deviceId: 'bean' }), e => e.code === 'DEVICE_ACK_TIMEOUT'); await timed.session.disconnect();
  const write = fixture({}, { writeFailure: true });
  await assert.rejects(write.session.connect({ deviceId: 'bean' }), e => e.code === 'BLE_API_FAILED' && e.platformCode === 10017); await write.session.disconnect();
});
test('drain timeout rejects instead of claiming all audio was delivered', async () => {
  let release; const f = await connected({ onFrame: () => new Promise(r => { release = r; }) });
  await f.session.readFile(vector.file_id); f.event(26, 8, slices()); await ticks();
  await assert.rejects(f.session.stop({ drain: true, timeoutMs: 5 }), e => e.code === 'DRAIN_TIMEOUT');
  release(); await ticks(); assert.equal(f.session.stats.audioFrames, 0); assert.equal(f.session._queue.length, 0);
});
test('explicit cancel interrupts an existing drain and cannot emit late frames', async () => {
  let release; const f = await connected({ onFrame: () => new Promise(r => { release = r; }) });
  await f.session.readFile(vector.file_id); f.event(26, 8, slices()); await ticks();
  const draining = f.session.stop({ drain: true });
  const cancellation = f.session.cancel();
  await assert.rejects(draining, e => e.code === 'CANCELLED');
  assert.equal((await cancellation).interrupted, true);
  release(); await ticks();
  assert.equal(f.session.stats.audioFrames, 0); assert.equal(f.session._queuedBytes, 0);
});
test('drain cannot silently discard a partially received BLE packet', async () => {
  const f = await connected(); await f.session.readFile(vector.file_id);
  f.hooks.value({ deviceId: 'bean', serviceId: require('../lib/feishu-ble').SERVICE,
    characteristicId: require('../lib/feishu-ble').NOTIFIER, value: '09ff00' });
  await assert.rejects(f.session.stop({ drain: true }), e => e.code === 'DRAIN_PARTIAL_FRAME');
  assert.equal(f.session._decoder.buffer.length, 0);
});
test('only information, ephemeral key, list and read commands pass the outgoing allowlist', () => {
  assert.equal(wire.prepareWrite(wire.listFiles(0)).length, 24);
  assert.equal(wire.prepareWrite(wire.readAudio(12345, 'replay')).length, 38);
  assert.throws(() => wire.readAudio(0, 'live'));
  assert.throws(() => wire.readAudio(12345, 'record'));
  // The start offset is in whole 166-byte slices.
  assert.deepEqual([...wire.readAudio(12345, 'live', 166)].slice(9, 18), [166, 0, 0, 0, 57, 48, 0, 0, 1]);
  assert.equal(wire.prepareWrite(wire.readAudio(12345, 'live', 166 * 3)).length, 38);
  assert.throws(() => wire.readAudio(12345, 'live', 100));
  assert.throws(() => wire.prepareWrite(wire.ephemeralPublicKey([4, ...Array(64).fill(1)])));
  assert.equal(wire.prepareWrite(wire.ephemeralPublicKey([4, ...Array(64).fill(1)]), { maxWriteBytes: 75 }).length, 150);
});

test('native short auth rejection predicate matches FE/FF without assuming status or checksum', () => {
  for (const code of [254, 255]) {
    const raw = [9, 255, 7, 8, 0, 46, 1, 2, 0, code, 123];
    const found = wire.authenticationRejection(raw);
    assert.equal(found.authenticationRejected, true);
    assert.equal(found.authenticationCode, code);
    assert.equal(found.checksumVerified, false);
    assert.equal(found.diagnosticRawHex, Buffer.from(raw).toString('hex'));
    const decoder = new wire.FrameDecoder();
    assert.deepEqual(decoder.push(raw.slice(0, 5)), []);
    const decoded = decoder.push(raw.slice(5));
    assert.equal(decoded[0].authenticationRejected, true);
    assert.equal(decoded[0].reassembled, true);
    assert.equal(decoder.invalidFrames, 0);
  }
  for (const group of [26, 27]) for (let id = 1; id < 7; id++) {
    assert.equal(wire.authenticationRejection([9, 255, 0, 0, 1, group, id, 2, 0, 254, 0]), null);
  }
  assert.equal(wire.authenticationRejection([9, 255, 0, 0, 1, 1, 1, 2, 0, 253, 0]), null);
  assert.equal(wire.authenticationRejection([9, 255, 0, 0, 1, 1, 1, 11, 0, 254, 0]), null);
});
test('auth rejection is visible immediately with the raw short frame, never an ACK timeout or automatic auth', async () => {
  const diagnostics = [];
  const f = fixture({ onDiagnostic: diagnostic => { if (diagnostic.type === 'authentication_rejection') diagnostics.push(diagnostic); } }, { manualAck: true });
  const connection = f.session.connect({ deviceId: 'bean' }); await ticks();
  const raw = '09ff07080001010200fe7b';
  f.hooks.value({ deviceId: 'bean', serviceId: require('../lib/feishu-ble').SERVICE,
    characteristicId: require('../lib/feishu-ble').NOTIFIER, value: raw });
  await assert.rejects(connection, error => error.code === 'DEVICE_AUTH_REJECTED' && error.authenticationCode === 254 && error.diagnosticRawHex === raw);
  await f.session.disconnect();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].notificationBytes, 11);
  assert.equal(diagnostics[0].reassembled, false);
  assert.equal(f.errors[0].code, 'DEVICE_AUTH_REJECTED');
  assert.equal(f.calls.filter(x => x.name === 'writeBLECharacteristicValue').length, 1);
});
function infoPayload(overrides = {}) {
  // Synthetic reply in the real 65-byte layout. Serial and case MAC are placeholders.
  const p = Array(65).fill(0);
  const ascii = (at, text) => [...text].forEach((ch, i) => { p[at + i] = ch.charCodeAt(0); });
  p[0] = 1; p[1] = 7; p[2] = 0; ascii(3, '04.92'); ascii(8, 'SERIALPLACEHOLDR');
  const view = new DataView(new ArrayBuffer(8)); view.setUint32(0, 7551136, true); view.setUint32(4, 6000000, true);
  new Uint8Array(view.buffer).forEach((byte, i) => { p[24 + i] = byte; });
  p[32] = 1; ascii(33, '1.2.1'); p[38] = 2; [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF].forEach((b, i) => { p[39 + i] = b; });
  p[50] = 0; ascii(51, '03.06');
  Object.entries(overrides).forEach(([index, value]) => { p[Number(index)] = value; });
  return p;
}
async function connectWithInfo(payload, options) {
  const f = fixture(options, { manualAck: true });
  const pending = f.session.connect({ deviceId: 'bean' }); await ticks();
  f.event(1, 1, payload); await ticks();
  f.event(46, 1, hex(vector.handshake_hex));
  return { f, connected: await pending };
}
test('device info exposes battery, charging, storage and firmware without identity bytes', async () => {
  const { f, connected } = await connectWithInfo(infoPayload());
  assert.deepEqual(connected.deviceInfo.status, { micBattery: 80, micCharging: false,
    storage: { totalKB: 7551136, freeKB: 6000000 }, caseCharging: true, caseFirmware: '1.2.1',
    caseBattery: 30, recording: false, wifiFirmware: '03.06' });
  assert.equal(connected.deviceInfo.firmware, '04.92');
  const text = JSON.stringify(connected.deviceInfo);
  assert.equal(text.includes('SERIAL'), false);
  assert.equal(/aa|bb|170|187/i.test(JSON.stringify(connected.deviceInfo.status)), false);
  await f.session.disconnect();
});
test('malformed device-info bytes stay unknown instead of being guessed', async () => {
  const { f, connected } = await connectWithInfo(infoPayload({ 1: 200, 2: 7, 32: 3, 33: 0x41, 50: 9 }));
  const status = connected.deviceInfo.status;
  assert.equal(status.micBattery, null); assert.equal(status.micCharging, null);
  assert.equal(status.caseCharging, null); assert.equal(status.caseFirmware, null); assert.equal(status.recording, null);
  await f.session.disconnect();
  const short = await connectWithInfo(Array(8).fill(0));
  assert.deepEqual(short.connected.deviceInfo.status, { micBattery: 10, micCharging: false, storage: null, caseCharging: null,
    caseFirmware: null, caseBattery: null, recording: null, wifiFirmware: null });
  await short.f.session.disconnect();
  const impossible = infoPayload(); impossible.splice(24, 8, 1, 0, 0, 0, 2, 0, 0, 0);
  const storage = await connectWithInfo(impossible);
  assert.equal(storage.connected.deviceInfo.status.storage, null);
  await storage.f.session.disconnect();
});
test('live battery and charging pushes refresh status without touching the audio path', async () => {
  const updates = [];
  const { f } = await connectWithInfo(infoPayload(), { onDeviceStatus: update => updates.push(update) });
  f.event(1, 3, [4, 9]); f.event(1, 4, [1, 0]); f.event(1, 3, [250, 3]); await ticks();
  assert.deepEqual(updates, [{ micBattery: 50, caseBattery: 100 }, { micCharging: true, caseCharging: false },
    { micBattery: null, caseBattery: 40 }]);
  assert.equal(f.frames.length, 0); assert.equal(f.errors.length, 0);
  await f.session.disconnect();
});
test('scan reports the advertised vendor-binding flag only when the layout is present', async () => {
  const f = fixture();
  const manufacturer = flags => new Uint8Array([1, 2, 3, 4, 5, 6, flags, 0]).buffer;
  f.api.startBluetoothDevicesDiscovery = args => {
    args.success({});
    f.hooks.found({ devices: [
      { deviceId: 'bound-bean', name: 'soundcore Work', advertisData: manufacturer(0x80) },
      { deviceId: 'free-bean', name: 'soundcore Work', advertisData: manufacturer(0x00) },
      { deviceId: 'short-bean', name: 'soundcore Work', advertisData: new Uint8Array([1, 2]).buffer },
      { deviceId: 'plain-bean', name: 'soundcore Work' }
    ] });
  };
  const devices = await f.session.scan({ durationMs: 1 });
  assert.deepEqual(devices.map(d => [d.deviceId, d.boundAdvertised]),
    [['bound-bean', true], ['free-bean', false], ['short-bean', null], ['plain-bean', null]]);
  await f.session.disconnect();
});
test('keep-alive live recording ends on the file marker without releasing the link', async () => {
  const f = await connected({ keepAlive: true });
  await f.session.startLive();
  f.event(26, 8, slices()); f.event(26, 10, []); await ticks();
  assert.equal(f.ends.length, 1); assert.equal(f.ends[0].reason, 'file_done'); assert.equal(f.ends[0].state, 'crypto_ready');
  assert.equal(f.ends[0].connectionKept, true); assert.equal(f.ends[0].audioFrames, 3);
  assert.equal(f.session.state, 'crypto_ready'); assert.equal(f.session.connected, true);
  assert.equal(f.calls.some(c => c.name === 'disconnectBLEDevice'), false);
  assert.ok(f.hooks.value, 'the notification listener stays for status pushes and the next file');
  // The recorder still lists the ended file as active: the next start waits for
  // a new file instead of reading the same one twice.
  const before = f.calls.filter(c => c.name === 'writeBLECharacteristicValue').length;
  f.session.startLive(); await ticks();
  const commands = f.calls.filter(c => c.name === 'writeBLECharacteristicValue').slice(before).map(c => wire.fromHex(c.args.value)[6]);
  assert.deepEqual(commands, [14]);
  assert.equal(f.session.state, 'waiting_for_recording'); assert.equal(f.errors.length, 0);
  await f.session.disconnect();
});
test('keep-alive end before any audio keeps the link and the next start reads a new file', async () => {
  const f = await connected({ keepAlive: true }, { activeFile: false });
  f.session.startLive(); await ticks();
  assert.equal(f.session.state, 'waiting_for_recording');
  const ended = await f.session.endTransfer({ drain: false });
  assert.equal(ended.connectionKept, true); assert.equal(ended.connectionClosed, false);
  assert.equal(f.session.state, 'crypto_ready'); assert.equal(f.session.mode, null);
  assert.equal(f.calls.some(c => c.name === 'disconnectBLEDevice'), false);
  assert.deepEqual(await f.session.endTransfer({ drain: true }), ended);
  await f.session.disconnect();
  assert.equal(f.calls.some(c => c.name === 'disconnectBLEDevice'), true);
});
test('without keep-alive the file marker still releases the link', async () => {
  const f = await connected();
  await f.session.startLive();
  f.event(26, 8, slices()); f.event(26, 10, []); await ticks();
  assert.equal(f.ends[0].state, 'completed'); assert.equal(f.session.state, 'completed');
  assert.equal(f.calls.some(c => c.name === 'disconnectBLEDevice'), true);
});
test('an idle kept link reports a physical-key recording without reading it', async () => {
  const detected = [], f = await connected({ keepAlive: true, onRecordingDetected: event => detected.push(event) });
  assert.equal(f.session.watch(), true);
  await ticks();
  assert.deepEqual(detected, [{ fileId: vector.file_id }]);
  const writes = () => f.calls.filter(c => c.name === 'writeBLECharacteristicValue').map(c => wire.fromHex(c.args.value));
  // Info, connection key, one listing, then the file's key negotiated at once.
  assert.deepEqual(writes().map(x => [x[5], x[6]]), [[1, 1], [46, 1], [26, 14], [46, 1]]);
  assert.equal(f.session.state, 'crypto_ready'); assert.equal(f.session._watching, false);
  // Reading the known file needs no second listing and no second key exchange.
  const before = writes().length;
  await f.session.startLive(vector.file_id);
  assert.deepEqual(writes().slice(before).map(x => [x[5], x[6]]), [[26, 7]]);
  assert.equal(f.session.state, 'streaming');
  await f.session.disconnect();
});
test('while idle the recorder state says a file the phone stopped receiving is still recording, until the key ends it', async () => {
  const states = [], recorder = {};
  const f = await connected({ keepAlive: true, watchIntervalMs: 20, onRecorderState: state => states.push(state) }, recorder);
  await f.session.startLive();
  f.event(26, 8, slices()); await ticks();
  // The phone stops receiving; the recorder keeps the same file going.
  await f.session.endTransfer({ drain: true });
  f.session.watch(); await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(states, [{ recording: true, unreceived: true }]);
  recorder.activeFile = false; // the physical key ended it
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(states, [{ recording: true, unreceived: true }, { recording: false, unreceived: false }]);
  assert.equal(f.errors.length, 0);
  await f.session.disconnect();
});

const writes = (f, id) => f.calls.filter(c => c.name === 'writeBLECharacteristicValue').map(c => wire.fromHex(c.args.value)).filter(frame => frame[6] === id);
async function freshStart(t, options, apiOptions) {
  // The recording started five seconds ago by the recorder's clock.
  const now = Date.now; Date.now = () => vector.file_id * 1000 + 5000; t.after(() => { Date.now = now; });
  const diagnostics = [], f = await connected({ keepAlive: true, readFromStart: true, onDiagnostic: event => diagnostics.push(event), ...options }, apiOptions);
  await f.session.startLive(vector.file_id);
  f.event(26, 8, slices()); await ticks();
  const offsets = writes(f, 7).map(frame => (frame[9] | (frame[10] << 8) | (frame[11] << 16) | (frame[12] << 24)) >>> 0);
  return { f, diagnostics, offsets };
}
test('a recording that has just started is read from its start, not from the recorder\'s current position', async t => {
  const { f, diagnostics, offsets } = await freshStart(t);
  assert.deepEqual(offsets, [166]);
  assert.ok(diagnostics.some(d => d.type === 'audio_requested' && d.phase === 'from_start'));
  assert.equal(f.session.state, 'streaming'); assert.equal(f.frames.length, 3); assert.equal(f.errors.length, 0);
  await f.session.disconnect();
});
for (const refusal of ['status', 'header']) {
  test('a recorder that refuses an offset by ' + refusal + ' is read from its current position instead', async t => {
    const { f, diagnostics, offsets } = await freshStart(t, {}, { refuseOffset: refusal });
    assert.deepEqual(offsets, [166, 0]);
    assert.ok(diagnostics.some(d => d.type === 'from_start_refused'));
    assert.equal(f.session.state, 'streaming'); assert.equal(f.frames.length, 3); assert.equal(f.errors.length, 0);
    await f.session.disconnect();
  });
}
test('reading from the start is off unless asked for', async t => {
  const off = await freshStart(t, { readFromStart: undefined });
  assert.deepEqual(off.offsets, [0]);
  await off.f.session.disconnect();
});
test('a recording found long after it started is read from the current position', async () => {
  // The test vector is days old by the real clock.
  const old = await connected({ keepAlive: true });
  await old.session.startLive(vector.file_id);
  assert.deepEqual(writes(old, 7).map(frame => frame[9]), [0]);
  await old.session.disconnect();
});

test('the recorder file list is read page by page, oldest first, with the file being recorded', async () => {
  const files = Array.from({ length: 23 }, (_, i) => ({ fileId: 1793600000 + i * 100, durationMs: 1000 + i }));
  const f = await connected({ keepAlive: true }, { files, activeId: files[22].fileId });
  const listing = await f.session.listAllFiles();
  assert.equal(listing.files.length, 23);
  assert.deepEqual(listing.files[0], { fileId: 1793600000, durationMs: 1000 });
  assert.deepEqual(listing.files[22], { fileId: 1793602200, durationMs: 1022 });
  assert.equal(listing.active, 1793602200);
  assert.deepEqual(writes(f, 14).map(frame => frame[9] | (frame[10] << 8)), [0, 1, 2]);
  // A full last page is closed by an empty one.
  const ten = await connected({ keepAlive: true }, { files: files.slice(0, 10) });
  assert.equal((await ten.session.listAllFiles()).files.length, 10);
  assert.deepEqual(writes(ten, 14).map(frame => frame[9]), [0, 1]);
  await f.session.disconnect(); await ten.session.disconnect();
});

test('deleting sends one id per command, never the file being recorded, and reports what the recorder refused', async () => {
  const files = [{ fileId: 1793630175, durationMs: 60000 }, { fileId: 1793631900, durationMs: 40300 }, { fileId: 1793640000, durationMs: 5000 }, { fileId: 1793650000, durationMs: 5000 }];
  const f = await connected({ keepAlive: true }, { files, activeId: 1793640000, deleteStatus: id => id === 1793631900 ? 2 : id === 1793650000 ? null : 1 });
  const result = await f.session.deleteFiles([1793630175, 1793631900, 1793640000, 1793650000]);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.deletedIds, [1793630175]);
  assert.deepEqual(result.failed, [1793631900, 1793640000, 1793650000]);
  // The exact frames of the vendor SDK; the active file is never sent.
  assert.deepEqual(writes(f, 16).map(frame => Buffer.from(frame).toString('hex')),
    ['08ee0000001a100e00df9fe86afe', '08ee0000001a100e009ca6e86ac2', '08ee0000001a100e0050ede86abd']);
  assert.deepEqual(files.map(file => file.fileId), [1793631900, 1793640000, 1793650000]);
  assert.equal(f.session.state, 'crypto_ready'); assert.equal(f.errors.length, 0);
  await assert.rejects(f.session.deleteFiles([]), /Explicit file IDs/);
  await assert.rejects(f.session.deleteFiles([0]), /Explicit file IDs/);
  await f.session.disconnect();
});

test('file management pauses watching, resumes it, and is refused while a recording is being read', async () => {
  const f = await connected({ keepAlive: true, watchIntervalMs: 20 }, { files: [], activeFile: false });
  f.session.watch();
  assert.equal((await f.session.listAllFiles()).files.length, 0);
  assert.equal(f.session._watching, true);
  const status = await f.session.readStatus();
  assert.equal(typeof status, 'object'); assert.equal(f.session._watching, true);
  f.session.startLive().catch(() => {});
  await assert.rejects(f.session.listAllFiles(), /idle link/);
  await assert.rejects(f.session.deleteFiles([1793630175]), /idle link/);
  await f.session.disconnect();
});

test('a link that keeps failing while watching backs off, reports once and ends as disconnected', async () => {
  const diagnostics = [];
  const f = await connected({ keepAlive: true, watchIntervalMs: 1, onDiagnostic: event => diagnostics.push(event) });
  let listings = 0; const write = f.api.writeBLECharacteristicValue;
  f.api.writeBLECharacteristicValue = args => {
    if (wire.fromHex(args.value)[6] === 14) { listings++; f.calls.push({ name: 'writeBLECharacteristicValue', args }); args.fail({ errCode: 10006 }); return; }
    write(args);
  };
  f.session.watch();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(listings, 8);
  assert.equal(diagnostics.filter(d => d.type === 'watch_failed').length, 1);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].code, 'DEVICE_DISCONNECTED');
  assert.equal(f.session._watching, false);
});

test('watching stays quiet without a recording and yields to startLive', async () => {
  const detected = [], f = await connected({ keepAlive: true, onRecordingDetected: event => detected.push(event) }, { activeFile: false });
  f.session.watch(); await ticks();
  assert.deepEqual(detected, []); assert.equal(f.session._watching, true);
  // startLive takes over even while a watch listing is in flight.
  const live = f.session.startLive(); await ticks();
  assert.equal(f.session._watching, false); assert.equal(f.session.state, 'waiting_for_recording'); assert.equal(f.errors.length, 0);
  await f.session.disconnect(); await live.catch(() => {});
  const g = await connected({ keepAlive: true });
  assert.equal(g.session.watch(), true); g.session.unwatch();
  const plain = await connected();
  assert.equal(plain.session.watch(), false);
  await g.session.disconnect(); await plain.session.disconnect();
});
test('an unanswered listing while watching is retried, so a later key press is still noticed', async () => {
  const detected = [], diagnostics = [];
  // Listings wait their own short timeout, not the 10 s ACK timeout of other commands.
  const f = await connected({ keepAlive: true, watchIntervalMs: 20, listTimeoutMs: 60,
    onRecordingDetected: event => detected.push(event), onDiagnostic: event => diagnostics.push(event) });
  const write = f.api.writeBLECharacteristicValue; let dropped = 0;
  f.api.writeBLECharacteristicValue = args => {
    const frame = wire.fromHex(args.value);
    // The first listing goes unanswered, as when the recorder is busy starting a file.
    if (frame[6] === 14 && dropped++ === 0) { f.calls.push({ name: 'writeBLECharacteristicValue', args }); args.success({}); return; }
    write(args);
  };
  f.session.watch();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(diagnostics.some(d => d.type === 'watch_failed' && d.code === 'DEVICE_ACK_TIMEOUT'));
  assert.deepEqual(detected, [{ fileId: vector.file_id }]);
  assert.ok(diagnostics.some(d => d.type === 'recording_detected' && d.command === 'watch'));
  assert.equal(f.errors.length, 0); assert.equal(f.session.state, 'crypto_ready');
  await f.session.disconnect();
});


const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function halfPacket() {
  // The next audio packet, only half received when the transfer ends.
  const { packet } = require('./d3200-fixture.cjs');
  const whole = packet(26, 8, Array.from(slices()));
  return wire.toHex(whole.slice(0, Math.floor(whole.length / 2)));
}
function notify(f, value) {
  const ble = require('../lib/feishu-ble');
  f.hooks.value({ deviceId: 'bean', serviceId: ble.SERVICE, characteristicId: ble.NOTIFIER, value });
}

test('a noticed recording no transfer takes up is watched for again after the prepared window', async () => {
  const recorder = { activeFile: false }, detected = [], states = [];
  const f = await connected({ keepAlive: true, watchIntervalMs: 20, preparedMs: 80,
    onRecordingDetected: event => detected.push(event.fileId), onRecorderState: state => states.push(state) }, recorder);
  f.session.watch(); await sleep(50);
  recorder.activeFile = true; await sleep(50);
  assert.equal(detected.length, 1); assert.equal(f.session._watching, false);
  // The page was busy and never started; the recorder keeps recording.
  await sleep(120);
  assert.equal(detected.length, 2, 'a recording still running is reported afresh');
  // Watching resumes again and follows the recorder once it stops.
  recorder.activeFile = false; await sleep(150);
  assert.equal(f.session._watching, true);
  assert.equal(JSON.stringify(states.map(state => state.recording)), JSON.stringify([false, true, false]));
  await f.session.disconnect();
});

test('a watch due while a file command runs starts when the command ends, and a transfer cancels it', async () => {
  const recorder = { activeFile: true }, detected = [];
  const f = await connected({ keepAlive: true, watchIntervalMs: 20, preparedMs: 40, onRecordingDetected: event => detected.push(event.fileId) }, recorder);
  f.session.watch(); await sleep(30);
  assert.equal(detected.length, 1);
  recorder.activeFile = false;
  await f.session._managing(async () => { await sleep(80); assert.equal(f.session._watching, false); });
  assert.equal(f.session._watching, true);
  await f.session.disconnect();
  // Taken up by a transfer: once it ends, watching is the runtime's call, not the timer's.
  const g = await connected({ keepAlive: true, watchIntervalMs: 20, preparedMs: 40 }, { activeFile: true });
  g.session.watch(); await sleep(30);
  g.session.startLive(); await ticks();
  await g.session.endTransfer({ drain: false }); await sleep(80);
  assert.equal(g.session._watching, false);
  await g.session.disconnect();
});

test('a cancel while a slice is decrypting leaves nothing behind for the next transfer', async () => {
  const f = await connected({ keepAlive: true });
  f.session.startLive(); await ticks();
  assert.equal(f.session.state, 'streaming');
  f.event(26, 8, slices());
  await f.session.endTransfer({ drain: false });
  await ticks(40);
  assert.equal(f.session.lastSequence, null); assert.equal(f.session.stats.audioFrames, 0); assert.equal(f.frames.length, 0);
  // The fixture's one file read again stands in for the next recording.
  f.session._endedFile = null;
  f.session.startLive(); await ticks(40);
  f.event(26, 8, slices()); await ticks(40);
  assert.equal(JSON.stringify(f.frames.map(frame => frame.sequence)), JSON.stringify([0, 1, 2]));
  assert.equal(f.session.stats.duplicates, 0); assert.equal(f.errors.length, 0);
  await f.session.disconnect();
});

test('a phone stop discards a half-received packet it no longer takes; the file-end path stays strict', async () => {
  const diagnostics = [];
  const f = await connected({ keepAlive: true, onDiagnostic: event => diagnostics.push(event) });
  f.session.startLive(); await ticks();
  f.event(26, 8, slices()); notify(f, halfPacket());
  const ended = await f.session.endTransfer({ drain: true });
  assert.equal(ended.connectionKept, true); assert.ok(ended.discardedPartialBytes > 0); assert.equal(ended.audioFrames, 3);
  assert.equal(f.session.state, 'crypto_ready'); assert.equal(f.errors.length, 0);
  assert.ok(diagnostics.some(event => event.type === 'partial_packet_discarded'));
  assert.equal(f.calls.some(call => call.name === 'disconnectBLEDevice'), false);
  await f.session.disconnect();
  // After the file-end marker a half packet still fails, and says so instead of going quiet.
  const g = await connected({ keepAlive: true });
  g.session.startLive(); await ticks();
  g.event(26, 8, slices()); g.event(26, 10, []); notify(g, halfPacket());
  await ticks(40);
  assert.equal(JSON.stringify(g.errors.map(error => error.code)), JSON.stringify(['DRAIN_PARTIAL_FRAME']));
  assert.equal(g.ends.length, 0); assert.ok(g.calls.some(call => call.name === 'disconnectBLEDevice'));
});
