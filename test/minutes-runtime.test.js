'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../h5/minutes-runtime.js'), 'utf8');

function harness(options = {}) {
  const calls = [], events = [], sockets = [], sent = [], requests = [];
  let device, ready, connectionAttempts = 0;
  class Device {
    constructor(tt, config) { this.config = config; device = this; calls.push('device-created'); }
    async scan() {
      calls.push('scan'); this.state = 'selection_ready';
      if (options.found) { this.config.onDevices(options.found); return options.found; }
      return [{ deviceId: 'own-device', name: 'soundcore Work' }];
    }
    async connect(selection) {
      calls.push('handshake');
      if (options.failConnectOnce && connectionAttempts++ === 0) throw new Error('first connection rejected');
      this.deviceId = selection.deviceId; this.state = 'crypto_ready';
      return options.deviceInfo ? { deviceInfo: options.deviceInfo } : undefined;
    }
    async startLive(fileId) { calls.push('wait-for-physical-recording'); this.liveFileId = fileId; }
    async stop(options) {
      assert.equal(options.drain, true);
      calls.push('drain-start');
      await new Promise(resolve => setTimeout(resolve, 8));
      calls.push('drain-end');
      this.config.onState({ state: 'stopped', phase: 'stopped' });
    }
    async endTransfer(options) {
      if (options.drain) {
        calls.push('drain-start');
        await new Promise(resolve => setTimeout(resolve, 8));
        calls.push('drain-end');
      } else calls.push('end-transfer');
      if (options.fail) throw new Error('end failed');
      this.config.onState({ state: 'crypto_ready', phase: 'crypto_ready', transferEnded: true });
      return { connectionKept: true, connectionClosed: false };
    }
    watch() { calls.push('watch'); return true; }
    async listAllFiles() { calls.push('list-files'); return { active: 0, files: [{ fileId: FILE_ID, durationMs: 1000 }, { fileId: FILE_ID - 60, durationMs: 2000 }] }; }
    async deleteFiles(ids) { calls.push('delete-files'); this.deletedIds = ids; return { deleted: ids.length }; }
    async readStatus() { calls.push('read-status'); return { storage: { totalKB: 1000, freeKB: 900 } }; }
    async disconnect() { calls.push('disconnect'); }
  }
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0; this.bufferedAmount = 0; sockets.push(this);
      if (options.refuseSocket) { setTimeout(() => { this.readyState = 3; this.onerror(); }, 0); return; }
      setTimeout(() => { this.readyState = 1; this.onopen(); }, 0);
    }
    send(value) {
      if (typeof value === 'string') {
        const message = JSON.parse(value); calls.push('ws-' + message.type);
        sent.push(message);
        if (message.type === 'start') {
          this.recordingId = message.recordingId;
          setTimeout(() => this.deliver({ type: 'ready' }), options.readyDelayMs || 0);
        }
        if (message.type === 'stop') setTimeout(() => this.deliver({ type: 'complete', recordingId: this.recordingId,
          durationMs: 20, audio: { url: (options.basePath || '') + '/api/audio/' + this.recordingId, mimeType: 'audio/wav' }, segments: [] }), 0);
      } else {
        calls.push('frame');
        assert.equal(value.byteLength, 164);
        const sequence = new DataView(value).getUint32(0, true);
        sent.push({ type: 'binary', sequence, bytes: value.byteLength });
        if (!options.noAck) this.deliver({ type: 'ack', sequence });
      }
    }
    deliver(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const context = {
    isSecureContext: true, crypto: { subtle: {} }, tt: {},
    navigator: { userAgent: options.browser ? 'Test Browser' : 'Feishu/7.69.24' },
    location: { href: 'https://private.example' + (options.basePath || '') + '/preview.html', protocol: 'https:', reload() { calls.push('reload'); } },
    h5sdk: { error() {}, ready(callback) { ready = callback; }, config(config) { config.onSuccess(); ready(); } },
    D3200Session: Device, WebSocket: Socket, URL, Uint8Array, ArrayBuffer, DataView, Blob,
    ...(options.tt ? { tt: options.tt } : {}),
    ...(options.Date ? { Date: options.Date } : {}),
    setTimeout: options.setTimeout || setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (path, requestOptions) => {
      calls.push('fetch:' + path);
      requests.push({ path, body: requestOptions && requestOptions.body ? JSON.parse(requestOptions.body) : null });
      const reply = options.respond && options.respond(path);
      if (reply === 'offline') throw new TypeError('Load failed');
      if (reply) return { ok: false, status: reply.status, json: async () => { if (!reply.body) throw new SyntaxError('not json'); return reply.body; } };
      return { ok: true, status: 200, json: async () => path === (options.basePath || '') + '/api/status' ? { jsapiConfigured: true } : {},
        blob: async () => new Blob([new Uint8Array(44)], { type: 'audio/wav' }) };
    }
  };
  if (options.localStorage) context.localStorage = options.localStorage;
  context.window = context;
  vm.runInNewContext(source, context);
  context.MinutesRuntime.subscribe(event => events.push(event));
  return { runtime: context.MinutesRuntime, calls, events, device: () => device, sockets, sent, requests };
}

const FILE_ID = 1793096883;
function verifiedHeader(h, changes = {}) {
  h.device().config.onState({ state: 'streaming', phase: 'streaming', fileKeyVerified: true,
    fileId: FILE_ID, sourceType: 'live_device_recording', ...changes });
}
function validFrame(changes = {}) {
  return { fileId: FILE_ID, sequence: 7, opus: new Uint8Array(160), sourceType: 'live_device_recording',
    receivedAtMs: 1793288100123, ...changes };
}
async function cachedAudio(h, recordingId) {
  for (let i = 0; i < 100; i++) {
    const event = h.events.find(item => item.type === 'audio_cached' && item.recordingId === recordingId);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('the saved audio was never cached on the phone');
}
async function startCapture(h, t, recordingId = 'recording-1') {
  t.after(() => h.runtime.disconnect());
  await h.runtime.connect();
  await h.runtime.start({ recordingId, language: 'zh' });
}

test('initialization never opens BLE or a billed ASR connection', async () => {
  const h = harness();
  const status = await h.runtime.init();
  assert.equal(status.connected, false);
  assert.deepEqual(h.calls, ['fetch:/api/status']);
});

test('failed service requests name the problem and the next step, never a bare status code', async () => {
  const replies = { '/api/recordings/a': { status: 501 }, '/api/recordings/b': { status: 404 }, '/api/recordings/c': { status: 409, body: { error: '文字已在其他页面更新，请刷新后核对再应用' } },
    '/api/recordings/d': { status: 401, body: { error: 'unauthorized' } }, '/api/recordings/e': { status: 400 }, '/api/recordings/f': 'offline',
    '/api/recordings/g': { status: 400, body: { error: 'Configured session limit reached' } } };
  const h = harness({ respond: path => replies[path] });
  const failure = async id => { try { await h.runtime.getRecording({ recordingId: id }); } catch (error) { return error; } assert.fail('request should fail'); };
  const a = await failure('a');
  assert.equal(a.message, '私有服务暂时不可用，请稍后重试；手机上的内容不受影响'); assert.equal(a.status, 501);
  assert.match((await failure('b')).message, /找不到这项内容/);
  assert.equal((await failure('c')).message, '文字已在其他页面更新，请刷新后核对再应用');
  assert.equal((await failure('d')).message, '私有测试登录已过期，请重新进入');
  assert.match((await failure('e')).message, /请刷新页面后重试/);
  assert.equal((await failure('f')).message, '连不上私有服务，请检查网络后重试');
  assert.match((await failure('g')).message, /请刷新页面后重试/);
  for (const id of 'abcdefg') assert.doesNotMatch((await failure(id)).message, /\d{3}|Load failed/);
});

test('ordinary browser cannot pretend to authenticate the Feishu BLE bridge', async () => {
  const h = harness({ browser: true });
  await assert.rejects(h.runtime.connect(), /iPhone 飞书/);
  assert.equal(h.device(), undefined);
});

test('failed BLE session is released and a fresh object is used for explicit retry', async () => {
  const h = harness({ failConnectOnce: true });
  await assert.rejects(h.runtime.connect(), /first connection rejected/);
  const result = await h.runtime.connect();
  assert.equal(result.connected, true);
  assert.equal(h.calls.filter(value => value === 'device-created').length, 2);
  assert.ok(h.calls.includes('disconnect'));
  await h.runtime.disconnect();
});

test('stop drains device frames before ending provider and delivers a real audio Blob', async () => {
  const h = harness();
  await h.runtime.connect();
  const started = await h.runtime.start({ recordingId: 'recording-1', language: 'zh' });
  assert.equal(started.phase, 'waiting');
  verifiedHeader(h);
  h.device().config.onFrame(validFrame());
  const result = await h.runtime.stop();
  assert.ok(h.calls.indexOf('drain-end') < h.calls.indexOf('ws-stop'));
  // The phone's copy follows the saved recording instead of holding up its end.
  assert.ok((await cachedAudio(h, result.recordingId)).blob instanceof Blob);
  assert.ok(h.events.some(event => event.type === 'audio' && event.durationMs === 20));
  assert.ok(h.events.some(event => event.type === 'status' && event.phase === 'stopped'));
  assert.equal(h.events.filter(event => event.type === 'status' && event.phase === 'stopped').length, 1);
  assert.equal(h.sockets[0].readyState, 3);
});

test('invalid compressed packet is rejected before WebSocket transmission', async () => {
  const h = harness();
  await h.runtime.connect();
  await h.runtime.start({ recordingId: 'recording-1' });
  assert.throws(() => h.device().config.onFrame({ sequence: 1, opus: new Uint8Array(159) }), /格式/);
  assert.equal(h.calls.includes('frame'), false);
  await h.runtime.disconnect();
});

test('a private path prefix is retained for signing, streaming, saved audio, and records', async () => {
  const h = harness({ basePath: '/minutes' });
  await h.runtime.connect();
  await h.runtime.start({ recordingId: 'recording-1', language: 'zh' });
  verifiedHeader(h);
  h.device().config.onFrame(validFrame());
  const result = await h.runtime.stop();
  await h.runtime.listRecordings();
  assert.equal(h.sockets[0].url, 'wss://private.example/minutes/api/stream');
  assert.equal(result.audio.url, '/minutes/api/audio/recording-1');
  // The phone's copy follows the saved recording instead of holding up its end.
  assert.ok((await cachedAudio(h, result.recordingId)).blob instanceof Blob);
  for (const path of ['/api/status', '/api/jsapi-config', '/api/audio/recording-1', '/api/recordings']) {
    assert.ok(h.calls.includes('fetch:/minutes' + path), path);
  }
  assert.equal(h.calls.some(value => value.startsWith('fetch:/api/')), false);
});

test('verified source identity is sent once before the unchanged audio frames', async t => {
  const h = harness();
  await startCapture(h, t);
  verifiedHeader(h);
  h.device().config.onFrame(validFrame());
  verifiedHeader(h); // The same status may be repeated without another identity message.
  h.device().config.onFrame(validFrame({ sequence: 8, receivedAtMs: 1793288100143 }));
  assert.deepEqual(h.sent.map(message => message.type), ['start', 'source_identity', 'binary', 'binary']);
  assert.deepEqual(h.sent[1], { type: 'source_identity', recordingId: 'recording-1', identity: {
    schemaVersion: 1, protocol: 'soundcore-d3200', fileId: FILE_ID, jsapiDeviceId: 'own-device',
    sourceType: 'live_device_recording', firstSequence: 7, firstReceivedAtMs: 1793288100123, headerIdMatched: true
  } });
  assert.deepEqual(h.sent.slice(2), [{ type: 'binary', sequence: 7, bytes: 164 }, { type: 'binary', sequence: 8, bytes: 164 }]);
  const result = await h.runtime.stop();
  assert.equal(result.recordingId, 'recording-1');
  assert.ok(h.calls.indexOf('drain-end') < h.calls.indexOf('ws-stop'));
  // The phone's copy follows the saved recording instead of holding up its end.
  assert.ok((await cachedAudio(h, result.recordingId)).blob instanceof Blob);
});

test('audio without a verified file header is rejected before any source or binary message', async t => {
  const h = harness();
  await startCapture(h, t);
  assert.throws(() => h.device().config.onFrame(validFrame()), /身份|音频头/);
  assert.deepEqual(h.sent.map(message => message.type), ['start']);
  assert.equal(h.sockets[0].readyState, 3);
});

test('invalid streaming header cannot establish a recording identity', async t => {
  for (const [name, changes] of [['unverified', { fileKeyVerified: false }], ['zero file ID', { fileId: 0 }],
    ['overflow file ID', { fileId: 0x100000000 }], ['fractional file ID', { fileId: 1.5 }]]) {
    await t.test(name, async child => {
      const h = harness();
      await startCapture(h, child);
      verifiedHeader(h, changes);
      assert.ok(h.events.some(event => event.type === 'error'));
      h.device().config.onFrame(validFrame());
      assert.deepEqual(h.sent.map(message => message.type), ['start']);
      assert.equal(h.sockets[0].readyState, 3);
    });
  }
});

test('changed file, device, or source type stops the recording without sending mixed audio', async t => {
  for (const change of ['file', 'device', 'source', 'header']) {
    await t.test(change, async child => {
      const h = harness();
      await startCapture(h, child);
      verifiedHeader(h);
      h.device().config.onFrame(validFrame());
      if (change === 'device') h.device().deviceId = 'another-device';
      if (change === 'header') {
        verifiedHeader(h, { fileId: FILE_ID + 1 });
        assert.ok(h.events.some(event => event.type === 'error'));
      } else {
        const changed = change === 'file' ? { fileId: FILE_ID + 1 } : change === 'source' ? { sourceType: 'device_recorded_file_replay' } : {};
        assert.throws(() => h.device().config.onFrame(validFrame({ sequence: 8, ...changed })), /身份|来源/);
      }
      h.device().config.onFrame(validFrame({ sequence: 9 })); // A late callback after failure is inert.
      assert.deepEqual(h.sent.map(message => message.type), ['start', 'source_identity', 'binary']);
      assert.equal(h.sockets[0].readyState, 3);
      const diagnostics = h.requests.filter(request => request.path.endsWith('/api/diagnostics'));
      assert.equal(JSON.stringify(diagnostics).includes('another-device'), false);
      assert.equal(JSON.stringify(diagnostics).includes('own-device'), false);
    });
  }
});

test('source sequence and receive timestamp must fit their declared wire ranges', async t => {
  const cases = [
    ['negative sequence', { sequence: -1 }], ['overflow sequence', { sequence: 0x100000000 }],
    ['fractional sequence', { sequence: 1.5 }], ['zero timestamp', { receivedAtMs: 0 }],
    ['unsafe timestamp', { receivedAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional timestamp', { receivedAtMs: 1.5 }], ['missing timestamp', { receivedAtMs: undefined }]
  ];
  for (const [name, changes] of cases) {
    await t.test(name, async child => {
      const h = harness();
      await startCapture(h, child);
      verifiedHeader(h);
      assert.throws(() => h.device().config.onFrame(validFrame(changes)));
      assert.deepEqual(h.sent.map(message => message.type), ['start']);
      assert.equal(h.sockets[0].readyState, 3);
    });
  }
});

test('old connection callbacks cannot bind or send audio into a later recording', async t => {
  const h = harness();
  await startCapture(h, t);
  verifiedHeader(h);
  const old = h.device();
  old.config.onFrame(validFrame());
  await h.runtime.stop();
  // A released and re-established link gets a new device object.
  await h.runtime.disconnect();
  await h.runtime.connect();
  assert.notEqual(h.device(), old);
  await h.runtime.start({ recordingId: 'recording-2' });
  const before = h.sent.length;
  old.config.onState({ state: 'streaming', phase: 'streaming', fileKeyVerified: true, fileId: FILE_ID + 1 });
  old.config.onFrame(validFrame({ fileId: FILE_ID + 1 }));
  assert.equal(h.sent.length, before);
  verifiedHeader(h, { fileId: FILE_ID + 2 });
  h.device().config.onFrame(validFrame({ fileId: FILE_ID + 2, sequence: 0 }));
  const identities = h.sent.filter(message => message.type === 'source_identity');
  assert.deepEqual(identities.map(message => [message.recordingId, message.identity.fileId]), [
    ['recording-1', FILE_ID], ['recording-2', FILE_ID + 2]
  ]);
  const result = await h.runtime.stop();
  assert.equal(result.recordingId, 'recording-2');
  assert.equal(h.events.some(event => event.type === 'error'), false);
});

test('a saved recording keeps the link, so the next one starts without a new handshake', async t => {
  const h = harness();
  await startCapture(h, t);
  verifiedHeader(h);
  h.device().config.onFrame(validFrame());
  const first = h.device();
  await h.runtime.stop();
  assert.equal(h.calls.includes('disconnect'), false);
  assert.equal((await h.runtime.connect()).connected, true);
  assert.equal(h.calls.filter(call => call === 'handshake').length, 1);
  assert.equal(h.device(), first);
  assert.ok(h.events.some(event => event.type === 'device' && event.device.connected === true));
  await h.runtime.start({ recordingId: 'recording-2', language: 'zh' });
  verifiedHeader(h, { fileId: FILE_ID + 1 });
  h.device().config.onFrame(validFrame({ fileId: FILE_ID + 1, sequence: 0 }));
  const result = await h.runtime.stop();
  assert.equal(result.recordingId, 'recording-2');
  assert.deepEqual(h.sent.filter(message => message.type === 'source_identity').map(message => message.identity.fileId), [FILE_ID, FILE_ID + 1]);
  assert.equal(h.events.some(event => event.type === 'error'), false);
});

test('cancelling before audio keeps the link; a device drop between recordings is quiet', async t => {
  const h = harness();
  await startCapture(h, t, 'recording-1');
  await h.runtime.abort();
  assert.ok(h.calls.includes('end-transfer')); assert.equal(h.calls.includes('disconnect'), false);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal((await h.runtime.connect()).connected, true);
  assert.equal(h.calls.filter(call => call === 'handshake').length, 1);
  const drop = new Error('gone'); drop.code = 'DEVICE_DISCONNECTED';
  h.device().config.onError(drop);
  assert.equal(h.events.some(event => event.type === 'error'), false);
  assert.ok(h.events.some(event => event.type === 'status' && event.phase === 'disconnected'));
  assert.equal(h.events.filter(event => event.type === 'device').pop().device.connected, false);
});

test('an idle link watches for the physical key and reports a new recording once', async t => {
  const h = harness();
  t.after(() => h.runtime.disconnect());
  await h.runtime.connect();
  assert.equal(h.calls.filter(call => call === 'watch').length, 1);
  h.device().config.onRecordingDetected({ fileId: FILE_ID });
  assert.deepEqual(h.events.filter(event => event.type === 'device_recording').map(event => event.fileId), [FILE_ID]);
  await h.runtime.start({ recordingId: 'recording-1', language: 'zh' });
  // While a recording is open, a detection is not reported again.
  h.device().config.onRecordingDetected({ fileId: FILE_ID });
  assert.equal(h.events.filter(event => event.type === 'device_recording').length, 1);
  verifiedHeader(h); h.device().config.onFrame(validFrame());
  await h.runtime.stop();
  assert.equal(h.calls.filter(call => call === 'watch').length, 2);
});

test('recorder files are listed and deleted only on an idle link, and storage is read again after deleting', async t => {
  const h = harness();
  t.after(() => h.runtime.disconnect());
  await assert.rejects(h.runtime.listDeviceFiles(), /请先连接录音豆/);
  await h.runtime.connect();
  assert.equal((await h.runtime.listDeviceFiles()).files.length, 2);
  for (const fileIds of [[], [1.5], [-1], 'all', Array.from({ length: 101 }, (_, i) => i + 1)]) {
    await assert.rejects(h.runtime.deleteDeviceFiles({ fileIds }), /请选择要删除的录音/);
  }
  assert.equal(h.calls.includes('delete-files'), false);
  assert.equal((await h.runtime.deleteDeviceFiles({ fileIds: [FILE_ID] })).deleted, 1);
  assert.equal(JSON.stringify(h.device().deletedIds), JSON.stringify([FILE_ID]));
  assert.equal(h.events.filter(event => event.type === 'device').pop().device.storage.freeKB, 900);
  // While a recording is being received the link is not shared.
  await h.runtime.start({ recordingId: 'recording-1', language: 'zh' });
  await assert.rejects(h.runtime.listDeviceFiles(), /正在接收录音/);
  await assert.rejects(h.runtime.deleteDeviceFiles({ fileIds: [FILE_ID] }), /正在接收录音/);
});

test('a recorder left recording after a phone stop buzzes once, and again only after it ended', async t => {
  let buzzes = 0;
  const h = harness({ tt: { vibrateLong(options) { buzzes++; options.success(); } } });
  t.after(() => h.runtime.disconnect());
  await h.runtime.connect();
  const state = value => h.device().config.onRecorderState(value);
  state({ recording: true, unreceived: true }); state({ recording: true, unreceived: true });
  assert.equal(buzzes, 1);
  state({ recording: false, unreceived: false }); state({ recording: true, unreceived: true });
  assert.equal(buzzes, 2);
  // A recording the phone is receiving never buzzes.
  state({ recording: false, unreceived: false }); state({ recording: true, unreceived: false });
  assert.equal(buzzes, 2);
});

test('the recorder state reaches the page, and a new link starts with nothing unreceived', async t => {
  const h = harness();
  t.after(() => h.runtime.disconnect());
  const recorder = () => h.events.filter(event => event.type === 'recorder').pop();
  await h.runtime.connect();
  assert.equal(recorder().unreceived, false);
  h.device().config.onRecorderState({ recording: true, unreceived: true });
  assert.equal(recorder().unreceived, true); assert.equal(recorder().recording, true);
  assert.equal(h.events.filter(event => event.type === 'device').pop().device.recording, true);
  h.device().config.onRecorderState({ recording: false, unreceived: false });
  assert.equal(recorder().unreceived, false);
  assert.equal(h.events.filter(event => event.type === 'device').pop().device.recording, false);
});

test('a key press reads the recorder at once and holds its audio until the stream is ready', async t => {
  const h = harness({ readyDelayMs: 30 });
  t.after(() => h.runtime.disconnect());
  await h.runtime.connect();
  const starting = h.runtime.start({ recordingId: 'recording-1', language: 'zh', fileId: FILE_ID });
  // The recorder streams only from the moment it is asked, so it is asked before the stream opens.
  assert.equal(h.device().liveFileId, FILE_ID);
  assert.equal(h.calls.includes('ws-start'), false);
  verifiedHeader(h);
  h.device().config.onFrame(validFrame({ sequence: 7 }));
  h.device().config.onFrame(validFrame({ sequence: 8 }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.sent.some(message => message.type === 'binary'), false);
  const started = await starting;
  assert.equal(started.phase, 'recording');
  assert.deepEqual(h.sent.filter(message => message.type !== 'start').map(message => message.type === 'binary' ? message.sequence : message.type),
    ['source_identity', 7, 8]);
  h.device().config.onFrame(validFrame({ sequence: 9 }));
  assert.equal(h.sent.pop().sequence, 9);
  // A started recording is never announced as waiting for the key.
  assert.equal(h.events.some(event => event.type === 'status' && event.phase === 'waiting'), false);
  assert.ok(h.events.some(event => event.type === 'status' && event.phase === 'recording'));
  await h.runtime.stop();
});

test('a recording that ends before the stream is ready still sends its held audio before stopping', async t => {
  const h = harness({ readyDelayMs: 30 });
  t.after(() => h.runtime.disconnect());
  await h.runtime.connect();
  const starting = h.runtime.start({ recordingId: 'recording-1', language: 'zh', fileId: FILE_ID });
  verifiedHeader(h);
  h.device().config.onFrame(validFrame({ sequence: 7 }));
  const stopping = h.runtime.stop();
  await starting;
  await stopping;
  const order = h.calls.filter(call => call === 'frame' || call === 'ws-stop');
  assert.deepEqual(order, ['frame', 'ws-stop']);
});

test('the start message names the realtime and file models, and post mode needs a file model', async t => {
  const h = harness();
  t.after(() => h.runtime.disconnect());
  await h.runtime.connect();
  await assert.rejects(h.runtime.start({ recordingId: 'recording-x', language: 'zh', liveModel: 'none' }), /可用的识别模型/);
  await h.runtime.start({ recordingId: 'recording-1', language: 'zh', liveModel: 'none', fileModel: 'doubao' });
  const start = h.sent.find(message => message.type === 'start');
  assert.equal(start.liveModel, 'none'); assert.equal(start.fileModel, 'doubao');
});

test('a stream refused by an expired private session signs in again by reloading', async () => {
  const h = harness({ refuseSocket: true, respond: path => path === '/api/status' && h.statusExpired ? { status: 401 } : null });
  await h.runtime.connect();
  h.statusExpired = true;
  await assert.rejects(h.runtime.start({ recordingId: 'recording-1', language: 'zh' }), /私有语音连接失败/);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(h.calls.includes('reload'));
  assert.ok(h.events.some(event => event.type === 'status' && event.phase === 'signing_in'));
  await h.runtime.disconnect();
});

test('device state comes only from a real reading, follows pushes and disconnects, and survives a reload', async () => {
  const storage = new Map();
  const localStorage = { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) };
  const h = harness({ localStorage, found: [{ deviceId: 'own-device', name: 'soundcore Work', boundAdvertised: false }],
    deviceInfo: { firmware: '04.92', status: { micBattery: 80, micCharging: true, caseBattery: 100, caseCharging: false,
      caseFirmware: '1.2.1', wifiFirmware: '03.06', storage: { totalKB: 7551136, freeKB: 7548704 }, recording: false } } });
  const opened = await h.runtime.init();
  assert.equal(opened.device, null);
  assert.equal(h.runtime.device(), null);
  assert.equal(h.calls.includes('handshake'), false);
  const result = await h.runtime.connect();
  assert.equal(result.device.connected, true);
  assert.deepEqual([result.device.micBattery, result.device.caseBattery, result.device.firmware, result.device.boundAdvertised],
    [80, 100, '04.92', false]);
  assert.match(result.device.readAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(result.device.boundReadAt, result.device.readAt);
  h.device().config.onDeviceStatus({ micBattery: 90, caseBattery: null });
  assert.equal(h.runtime.device().micBattery, 90);
  assert.equal(h.runtime.device().caseBattery, 100);
  await h.runtime.disconnect();
  assert.equal(h.runtime.device().connected, false);
  assert.equal(h.runtime.device().micBattery, 90);
  assert.equal(h.events.filter(event => event.type === 'device').at(-1).device.connected, false);
  const stored = storage.get('minutes.device.v1');
  assert.equal(stored.includes('own-device'), false);
  assert.equal('connected' in JSON.parse(stored), false);
  const reopened = harness({ localStorage });
  const reading = (await reopened.runtime.init()).device;
  assert.equal(reading.connected, false);
  assert.deepEqual([reading.micBattery, reading.caseBattery, reading.boundAdvertised], [90, 100, false]);
  assert.equal(reopened.calls.includes('handshake'), false);
});

test('a push received while disconnected cannot overwrite the last reading', async () => {
  const h = harness({ deviceInfo: { firmware: '04.92', status: { micBattery: 50 } } });
  await h.runtime.init(); await h.runtime.connect(); await h.runtime.disconnect();
  h.device().config.onDeviceStatus({ micBattery: 10 });
  assert.equal(h.runtime.device().micBattery, 50);
});

test('live translation events reach subscribers for the current recording only', async () => {
  const h = harness();
  await h.runtime.init(); await h.runtime.connect();
  try {
    await h.runtime.start({ recordingId: 'rec-live', language: 'zh' });
    const live = { type: 'translation', segmentId: 's1', sourceRevision: 0, revision: 0, language: 'en', text: 'Hello', final: true };
    h.sockets[0].deliver({ type: 'translation', recordingId: 'rec-live', event: live });
    const translation = h.events.find(event => event.type === 'translation');
    // Objects built inside the vm realm carry its prototypes; compare by value.
    assert.deepEqual(JSON.parse(JSON.stringify(translation.event)), live);
    h.sockets[0].deliver({ type: 'translation', recordingId: 'someone-else', event: { ...live, segmentId: 's9' } });
    assert.equal(h.events.some(event => event.event && event.event.segmentId === 's9'), false);
  } finally { await h.runtime.disconnect(); }
});

test('a failed phone copy of the audio never fails a recording the service has saved', async t => {
  const h = harness({ respond: path => path.startsWith('/api/audio/') ? { status: 502 } : null });
  await startCapture(h, t);
  verifiedHeader(h); h.device().config.onFrame(validFrame());
  const result = await h.runtime.stop();
  assert.equal(result.recordingId, 'recording-1'); assert.equal(result.audio.url, '/api/audio/recording-1');
  const audio = h.events.find(event => event.type === 'audio');
  assert.equal(audio.audio.url, '/api/audio/recording-1'); assert.equal(audio.audio.blob, undefined);
  assert.equal(h.events.some(event => event.type === 'error'), false);
  // The BLE link is kept and watching resumes for the next recording.
  assert.equal(h.runtime.device().connected, true); assert.equal(h.calls.includes('disconnect'), false);
  assert.equal(h.calls.filter(call => call === 'watch').length, 2);
  for (let i = 0; i < 50 && !h.requests.some(r => r.path === '/api/diagnostics' && r.body.type === 'audio_cache_failed'); i++) await new Promise(resolve => setTimeout(resolve, 1));
  const diagnostic = h.requests.find(r => r.path === '/api/diagnostics' && r.body.type === 'audio_cache_failed');
  assert.equal(diagnostic.body.code, 'HTTP_502'); assert.equal(diagnostic.body.recordingId, 'recording-1');
  assert.equal(h.events.some(event => event.type === 'audio_cached'), false);
});

test('the final text is waited for up to 90 s, since the service may take ~48 s to finish', async t => {
  const delays = [];
  const h = harness({ setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms); } });
  await startCapture(h, t);
  verifiedHeader(h); h.device().config.onFrame(validFrame());
  await h.runtime.stop();
  assert.ok(delays.includes(90000)); assert.equal(delays.includes(40000), false);
});

test('unacknowledged audio ends the stream by the acknowledgement timeout, not by an earlier backlog cap', async t => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const h = harness({ noAck: true, Date: Clock });
  await startCapture(h, t);
  verifiedHeader(h);
  // 1100 frames (22 s) once stopped the stream at frame 1025, before either timeout could.
  for (let sequence = 1; sequence <= 1100; sequence++) h.device().config.onFrame(validFrame({ sequence, receivedAtMs: 1793288100123 + sequence }));
  assert.equal(h.events.some(event => event.type === 'error'), false);
  assert.equal(h.sent.filter(message => message.type === 'binary').length, 1100);
  now += 31000;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(JSON.stringify(h.events.filter(event => event.type === 'error').map(event => event.message)), JSON.stringify(['音频发送确认超时，接收已中断']));
});

test('audio arriving moves a waiting recording to recording, whatever the service reports later', async t => {
  const h = harness();
  await startCapture(h, t);
  assert.equal(h.events.filter(event => event.type === 'status').pop().phase, 'waiting');
  verifiedHeader(h);
  const status = h.events.filter(event => event.type === 'status').pop();
  assert.equal(status.phase, 'recording'); assert.equal(status.recordingId, 'recording-1');
});

test('a dismissed device listing or a failed idle session is never reused for the next connection', async () => {
  const h = harness({ found: [{ deviceId: 'bean-a', name: 'soundcore Work' }, { deviceId: 'bean-b', name: 'soundcore Work' }] });
  const listing = await h.runtime.connect();
  assert.equal(listing.connected, false); assert.equal(listing.devices.length, 2);
  const listed = h.device();
  // Picking from the listing just shown reuses its session.
  assert.equal((await h.runtime.connect({ deviceId: 'bean-b' })).connected, true);
  assert.equal(h.device(), listed); assert.equal(h.device().deviceId, 'bean-b');
  await h.runtime.disconnect();
  // A listing the user dismissed: the next tap scans again with a fresh session.
  await h.runtime.connect();
  const dismissed = h.device();
  await h.runtime.connect();
  assert.notEqual(h.device(), dismissed); assert.equal(h.calls.filter(call => call === 'scan').length, 3);
  await h.runtime.connect({ deviceId: 'bean-a' });
  // A session that failed while idle (not a disconnect) is released, and the next connection is new.
  const failed = h.device();
  const broken = new Error('Invalid BLE packet checksum or length'); broken.code = 'BLE_FRAME_CHECKSUM';
  failed.config.onError(broken);
  assert.equal(h.runtime.device().connected, false);
  await h.runtime.connect();
  assert.notEqual(h.device(), failed);
  await h.runtime.disconnect();
});
