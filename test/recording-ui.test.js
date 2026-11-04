'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../lib/recording-store');

async function fixture(options = {}) {
  let definition, listener;
  const records = new Map(), calls = [], timers = new Map(); let timerId = 0;
  const local = {
    async list() { return [...records.values()].map(value => structuredClone(value)); },
    // holdGet delays a read after it has taken its copy, like a slow IndexedDB read.
    async get(id) { const copy = records.has(id) ? structuredClone(records.get(id)) : null; if (options.holdGet) await options.holdGet(id); return copy; },
    async save(record) { if (options.saveError) throw new Error('disk full'); const saved = structuredClone(record); records.set(record.id, saved); return saved; }
  };
  const result = { durationMs: 2200, audio: { url: '/api/audio/test', mimeType: 'audio/wav', blob: new Blob(['wave'], { type: 'audio/wav' }) },
    segments: [{ id: 'seg-1', source: '今天讨论项目安排。', sourceLanguage: 'zh', sourceRevision: 1, sourceFinal: true, startMs: 100, endMs: 2100, speaker: '发言人' }] };
  const runtime = {
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    async init() { calls.push('init'); return { connected: false, capabilities: { capture: true, summary: true, translation: true }, sourceLabel: 'soundcore Work', device: options.initDevice || null }; },
    async connect(request) { calls.push(['connect', request]); if (options.connectError) throw new Error(options.connectError); return options.devices && !request.deviceId ? { connected: false, devices: options.devices } : { connected: true }; },
    async start(request) { calls.push(['start', request]); return { phase: 'waiting', startedAt: '2026-10-29T00:00:00.000Z' }; },
    async stop() { calls.push('stop'); if (options.stopError) throw new Error('tail audio unconfirmed'); return result; },
    async disconnect() { calls.push('disconnect'); },
    async summarize() { calls.push('summarize'); return { summary: '讨论了项目安排。', chapters: [{ title: '项目安排', startMs: 100 }] }; },
    async translate() { calls.push('translate'); return { translations: [{ id: 'seg-1', text: 'Discuss the project plan.', language: 'en' }] }; }
  };
  const host = { pause() { calls.push('pause'); }, dispose() {}, validAudioUrl(url) { return url.startsWith('/'); },
    setAudio(value) { calls.push(['audio', value]); }, setPlaybackRate(value) { calls.push(['speed', value]); }, async play() { calls.push('play'); },
    seekFraction(value) { calls.push(['seek', value]); }, skip(value) { calls.push(['skip', value]); }, seekSeconds(value) { calls.push(['seekSeconds', value]); },
    textBlob(value, type) { return new Blob([value], { type }); }, download(blob, name) { calls.push(['download', blob, name]); if (options.download) return options.download(blob, name); }, async fetchAudio() { throw new Error('Unexpected duplicate audio fetch'); } };
  const sandbox = { Page(value) { definition = value; }, require() { return model; }, window: { MinutesRuntime: runtime, MinutesStore: local, MinutesHost: host, localStorage: options.localStorage },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval() { throw new Error('Playback must never use a simulated timer'); }, tt: new Proxy({}, { get() { throw new Error('Unexpected platform call'); } }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/index/index.js'), 'utf8'), sandbox);
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  await page.onLoad();
  return { page, calls, records, timers, runtime, result, emit(event) { listener(event); } };
}

async function capture(f) {
  await f.page.newRecording(); await f.page.connectDevice(); await f.page.startCapture();
  f.emit({ type: 'caption', recordingId: f.page.record.id, event: { type: 'transcript', segmentId: 'seg-1', revision: 0, language: 'zh', text: '今天讨论', final: false, startMs: 100, endMs: null, speaker: '发言人' } });
  await f.page.stopCapture();
}

function seedPendingEdit(f, source) {
  // Older app versions allowed manual edits; an unsent edit can still sit in the
  // local cache, and the sync on open must keep protecting it.
  const saved = f.records.get(f.page.record.id), row = saved.segments[0];
  saved.segments[0] = { ...row, source, translation: '', translationFinal: false, translationRevision: -1, contentEdited: true,
    editedFields: ['source'], baseSourceRevision: row.sourceRevision, edited: true, speakerEdited: false, timingEdited: false };
  saved.contentEdited = true; saved.localPending = true;
}

test('default opening only reads state and never starts or connects a device', async () => {
  const f = await fixture();
  assert.deepEqual(f.calls, ['init']); assert.equal(f.page.data.records.length, 0); assert.equal(f.page.data.rows.length, 0);
  assert.equal(f.page.data.view, 'library'); assert.equal(f.timers.size, 0);
});

test('device selection is explicit and waiting is not recorded as receiving', async () => {
  const f = await fixture({ devices: [{ deviceId: 'one', name: 'Device 1' }, { deviceId: 'two', name: 'Device 2' }] });
  await f.page.newRecording(); await f.page.connectDevice();
  assert.equal(f.page.data.connected, false); assert.equal(f.page.data.devices.length, 2);
  await f.page.connectDevice({ currentTarget: { dataset: { device: 'two' } } });
  await f.page.startCapture();
  assert.equal(f.page.data.captureState, 'waiting'); assert.equal(f.page.record.segments.length, 0); assert.equal(f.page.data.running, false);
  assert.deepEqual(f.calls.find(call => Array.isArray(call) && call[0] === 'start')[1].language, 'zh');
});

test('actual caption/audio completion saves, reopens and controls real audio without replay timers', async () => {
  const f = await fixture(); await capture(f);
  const id = f.page.record.id;
  assert.equal(f.page.data.captureState, 'stopped'); assert.equal(f.page.data.saved, true); assert.equal(f.page.data.rows[0].source, '今天讨论项目安排。');
  assert.equal(f.records.get(id).audioBlob.size, 4);
  await f.page.goBack(); assert.equal(f.page.data.records.length, 1); await f.page.openRecording(id);
  assert.equal(f.page.data.hasAudio, true); assert.equal(f.page.data.rows[0].time, '00:00');
  await f.page.togglePlayback(); assert.equal(f.page.data.running, false);
  f.page.onAudioState('playing'); assert.equal(f.page.data.running, true);
  f.page.onAudioTime({ currentTime: 1.1, duration: 2.2 }); assert.equal(f.page.data.progress, 50);
  f.page.seek(80); assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'seek' && call[1] === 0.8));
  f.page.cycleSpeed(); f.page.cycleSpeed(); f.page.cycleSpeed();
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'speed').slice(-3).map(call => call[1]), [1.5, 2, 1]);
  assert.equal(f.page.data.speed, 1);
  assert.equal(f.timers.size, 0);
});

test('failed stop preserves received captions and never claims completion', async () => {
  const f = await fixture({ stopError: true }); await capture(f);
  assert.equal(f.page.data.captureState, 'error'); assert.equal(f.page.record.state, 'error');
  assert.equal(f.page.record.segments[0].source, '今天讨论'); assert.equal(f.page.data.hasAudio, false);
  assert.match(f.page.data.notice, /unconfirmed/);
});

test('an unreadable cached audio blob falls back once to the same-origin saved audio without deleting the cache', async () => {
  const f = await fixture(); await capture(f);
  const blob = f.page.record.audioBlob;
  f.page.onAudioState('error');
  const audioCalls = () => f.calls.filter(call => Array.isArray(call) && call[0] === 'audio');
  assert.equal(audioCalls().length, 2);
  assert.equal(audioCalls()[1][1].url, '/api/audio/test');
  assert.equal(audioCalls()[1][1].blob, null);
  assert.equal(f.page.record.audioBlob, blob);
  assert.match(f.page.data.notice, /私有服务音频/);
  f.page.loadAudio();
  assert.equal(audioCalls().length, 2);
  f.page.onAudioState('playing');
  assert.equal(f.page.data.notice, '');
  f.page.onAudioState('error');
  assert.equal(audioCalls().length, 2);
  assert.match(f.page.data.notice, /音频播放失败/);
});

test('cached playback failures do not fall back to a missing or untrusted URL', async () => {
  for (const url of [null, 'https://other.test/audio']) {
    const f = await fixture(); await capture(f);
    f.page.record.audioUrl = url;
    f.page.onAudioState('error');
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'audio').length, 1);
    assert.match(f.page.data.notice, /音频播放失败/);
  }
});

test('save failure remains visible and received audio stays available for export', async () => {
  const f = await fixture({ saveError: true }); await capture(f);
  assert.equal(f.page.data.saved, false); assert.match(f.page.data.saveStatus, /保存失败/); assert.equal(f.page.data.hasAudio, true);
  await f.page.exportFile('audio');
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'download' && call[2].endsWith('.wav')));
});

test('successful local recovery clears only the matching save failure notice', async () => {
  const options = {}, f = await fixture(options);
  await f.page.newRecording(); options.saveError = true;
  assert.equal(await f.page.saveCurrent(), false);
  assert.equal(f.page.data.notice, 'disk full');
  options.saveError = false;
  assert.equal(await f.page.saveCurrent(), true);
  assert.equal(f.page.data.notice, ''); assert.equal(f.page.data.saved, true);
  options.saveError = true; await f.page.saveCurrent();
  f.page.setData({ notice: '蓝牙连接中断，请重新连接' });
  options.saveError = false; await f.page.saveCurrent();
  assert.equal(f.page.data.notice, '蓝牙连接中断，请重新连接');
});

test('export awaits the system action and cancellation keeps the export choices open', async () => {
  let finish;
  const f = await fixture({ download: () => new Promise(resolve => { finish = resolve; }) });
  await capture(f); f.page.toggleOptions();
  const pending = f.page.exportFile('txt');
  await f.page.exportFile('txt');
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'download').length, 1);
  assert.equal(f.page.data.optionsOpen, true);
  finish({ method: 'system', cancelled: true }); await pending;
  assert.equal(f.page.data.notice, '已取消导出。');
  assert.equal(f.page.data.optionsOpen, true); assert.equal(f.page.exporting, false);
});

test('a rejected system export remains retryable and never reports a saved file', async () => {
  const f = await fixture({ download: async () => { throw new Error('系统未打开文件菜单'); } });
  await capture(f); f.page.toggleOptions(); await f.page.exportFile('audio');
  assert.match(f.page.data.notice, /未打开/);
  assert.equal(f.page.data.optionsOpen, true); assert.equal(f.page.exporting, false);
});

const textOf = parts => parts.map(part => part.text).join('');

test('search, translation, display modes and export all use the saved recording', async () => {
  const f = await fixture(); await capture(f);
  f.page.toggleSearch(); f.page.updateSearch('项目'); assert.equal(f.page.data.searchCount, 1);
  f.page.clearSearch();
  assert.equal(f.page.data.displayMode, 'both');
  assert.equal(f.page.data.translationMissing, 1); assert.equal(f.page.data.rows[0].pendingTranslation, true);
  await f.page.requestTranslation();
  assert.equal(f.calls.includes('translate'), true);
  assert.equal(f.page.data.rows[0].translation, 'Discuss the project plan.');
  assert.equal(f.page.data.translationMissing, 0);
  assert.equal(textOf(f.page.data.rows[0].primaryParts), '今天讨论项目安排。');
  assert.equal(textOf(f.page.data.rows[0].secondaryParts), 'Discuss the project plan.');
  f.page.setDisplayMode('en');
  assert.equal(textOf(f.page.data.rows[0].primaryParts), 'Discuss the project plan.');
  assert.equal(f.page.data.rows[0].secondaryParts.length, 0); assert.equal(f.page.data.rows[0].untranslated, false);
  f.page.setDisplayMode('zh');
  assert.equal(textOf(f.page.data.rows[0].primaryParts), '今天讨论项目安排。');
  f.page.setDisplayMode('fr'); assert.equal(f.page.data.displayMode, 'zh');
  f.page.setDisplayMode('both'); f.page.toggleSearch(); f.page.updateSearch('PROJECT');
  assert.equal(f.page.data.searchCount, 1); // search reaches the translation that is on screen
  f.page.clearSearch();
  await f.page.exportFile('txt'); const download = f.calls.filter(call => Array.isArray(call) && call[0] === 'download').at(-1);
  assert.match(download[2], /\.txt$/); assert.match(await download[1].text(), /Discuss the project plan\./);
  const before = f.calls.length; await f.page.exportFile('srt');
  assert.equal(f.calls.slice(before).some(call => Array.isArray(call) && call[0] === 'download'), false);
});

test('a missing translation in a single-language view falls back to the source and says so', async () => {
  const f = await fixture(); await capture(f);
  f.page.setDisplayMode('en');
  assert.equal(textOf(f.page.data.rows[0].primaryParts), '今天讨论项目安排。');
  assert.equal(f.page.data.rows[0].untranslated, true);
  assert.equal(f.page.data.translationMissing, 1);
});

test('live translation events attach to the captured sentence and only to its source revision', async () => {
  const f = await fixture();
  await f.page.newRecording(); await f.page.connectDevice(); await f.page.startCapture();
  const id = f.page.record.id;
  f.emit({ type: 'caption', recordingId: id, event: { type: 'transcript', segmentId: 'seg-9', revision: 0, language: 'zh', text: '下周三复盘。', final: true, startMs: 0, endMs: 900, speaker: '发言人' } });
  f.emit({ type: 'translation', recordingId: id, event: { type: 'translation', segmentId: 'seg-9', sourceRevision: 0, revision: 0, language: 'en', text: 'Review next Wednesday.', final: true } });
  assert.equal(f.page.record.segments[0].translation, 'Review next Wednesday.');
  assert.equal(textOf(f.page.data.rows[0].secondaryParts), 'Review next Wednesday.');
  f.emit({ type: 'caption', recordingId: id, event: { type: 'transcript', segmentId: 'seg-9', revision: 1, language: 'zh', text: '下周三下午复盘。', final: true, startMs: 0, endMs: 1200, speaker: '发言人' } });
  f.emit({ type: 'translation', recordingId: id, event: { type: 'translation', segmentId: 'seg-9', sourceRevision: 0, revision: 1, language: 'en', text: 'Stale.', final: true } });
  assert.notEqual(f.page.record.segments[0].translation, 'Stale.');
  f.emit({ type: 'translation', recordingId: 'another-recording', event: { type: 'translation', segmentId: 'seg-9', sourceRevision: 1, revision: 2, language: 'en', text: 'Wrong recording.', final: true } });
  assert.notEqual(f.page.record.segments[0].translation, 'Wrong recording.');
});

test('duplicate automatic completion and explicit stop are idempotent for the audio source', async () => {
  const f = await fixture(); await f.page.newRecording();
  await Promise.all([f.page.applyResult(f.result), f.page.applyResult(f.result)]);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'audio').length, 1);
  assert.equal(f.records.get(f.page.record.id).segments.length, 1);
});

test('playback tests retain provenance and URL-only audio is not claimed as locally cached', async () => {
  const f = await fixture();
  const record = model.createRecord({ id: 'service-replay', sourceType: 'recorded_file_test' });
  record.state = 'stopped'; record.audioUrl = '/api/audio/service-replay'; record.durationMs = 2200;
  f.records.set(record.id, record); await f.page.loadLibrary(); await f.page.openRecording(record.id);
  assert.equal(f.page.data.originLabel, '已有录音回放 · 非现场录制');
  assert.match(f.page.data.saveStatus, /音频来自私有服务/);
  assert.doesNotMatch(f.page.data.saveStatus, /音频与文字已缓存本机/);
});

test('server sync failure preserves the local recording and reports the unsynced state', async () => {
  const f = await fixture(); f.runtime.saveRecording = async () => { throw new Error('sync unavailable'); };
  await capture(f);
  // The service sync runs after the stop has finished on the phone.
  await f.page.syncQueue;
  assert.equal(f.page.data.saved, true); assert.equal(f.records.get(f.page.record.id).audioBlob.size, 4);
  assert.match(f.page.data.saveStatus, /服务同步失败/); assert.equal(f.page.data.syncFailed, true); assert.equal(f.page.data.notice, '');
  f.runtime.saveRecording = async () => ({ saved: true });
  await f.page.retrySync();
  assert.equal(f.page.data.syncFailed, false); assert.equal(f.records.get(f.page.record.id).serverSaved, true);
});

test('cancelling before the physical key is pressed leaves no recording behind', async () => {
  const f = await fixture(); const synced = [];
  f.runtime.saveRecording = async snapshot => { synced.push(snapshot.id); return { saved: true }; };
  await f.page.connectDevice(); await f.page.beginRecording();
  assert.equal(f.page.data.captureState, 'waiting');
  await f.page.cancelCapture();
  assert.equal(f.page.data.view, 'library'); assert.equal(f.page.data.connected, false);
  assert.equal(f.page.data.records.length, 0); assert.deepEqual(synced, []);
  assert.ok(f.calls.includes('disconnect')); assert.match(f.page.data.notice, /没有录到内容/);
  await capture(f);
  await f.page.cancelCapture(); assert.equal(f.page.data.view, 'detail');
});

test('a partial translation response cannot be presented as a completed translation', async () => {
  const f = await fixture(); await capture(f); await f.page.requestTranslation();
  f.runtime.translate = async () => ({ translations: [{ id: 'unknown', text: 'Wrong row.' }] });
  await f.page.requestTranslation();
  assert.equal(f.page.data.translationStatus, 'error'); assert.equal(f.page.data.rows[0].translation, 'Discuss the project plan.');
  assert.match(f.page.data.notice, /未返回全部/);
});

test('a failed stop keeps what arrived and still lets the page go back and record again', async () => {
  const f = await fixture({ stopError: true }); await capture(f);
  const id = f.page.record.id;
  assert.equal(f.page.data.captureState, 'error'); assert.equal(f.page.isCapturing(), false); assert.equal(f.page.data.sessionOpen, false);
  assert.equal(f.records.get(id).state, 'error'); assert.equal(f.records.get(id).segments[0].source, '今天讨论');
  await f.page.goBack(); assert.equal(f.page.data.view, 'library');
  assert.equal(f.page.data.records.some(record => record.id === id), true);
  await f.page.newRecording(); assert.notEqual(f.page.record.id, id); assert.equal(f.page.data.captureState, 'draft');
});

test('a failure reported while recording ends the capture so the page is never stuck', async () => {
  const f = await fixture(); const synced = [];
  f.runtime.saveRecording = async snapshot => { synced.push(snapshot.state); return { saved: true }; };
  await f.page.connectDevice(); await f.page.beginRecording();
  const id = f.page.record.id;
  f.emit({ type: 'status', phase: 'recording', recordingId: id, message: '录音豆正在录音，正在接收…' });
  f.emit({ type: 'caption', recordingId: id, event: { type: 'transcript', segmentId: 'seg-1', revision: 0, language: 'zh', text: '已经收到的话', final: true, startMs: 0, endMs: 900, speaker: '发言人' } });
  // A BLE drop, a closed stream or a service restart: the runtime has already released the recording.
  f.emit({ type: 'error', recordingId: id, message: '语音连接中断，已保留已收到的文字；请先停止设备录音' });
  f.emit({ type: 'device', device: { connected: false } });
  assert.equal(f.page.isCapturing(), false); assert.equal(f.page.data.captureState, 'error'); assert.equal(f.page.data.sessionOpen, false);
  assert.match(f.page.data.notice, /语音连接中断/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.records.get(id).state, 'error'); assert.equal(f.records.get(id).segments[0].source, '已经收到的话');
  assert.ok(synced.includes('error'));
  await f.page.goBack(); assert.equal(f.page.data.view, 'library');
  await f.page.connectDevice(); assert.equal(f.page.data.connected, true);
  await f.page.beginRecording(); assert.notEqual(f.page.record.id, id); assert.equal(f.page.isCapturing(), true);
});

test('restoring finalized server data keeps explicit pending edits and exposes source conflicts', async () => {
  const f = await fixture(); await capture(f);
  seedPendingEdit(f, '未同步的手工正文');
  const id = f.page.record.id;
  const remote = { ...structuredClone(f.records.get(id)), localPending: false, contentEdited: false, updatedAt: '2099-01-01T00:00:00.000Z',
    segments: [{ id: 'seg-1', source: '服务端最终正文', sourceLanguage: 'zh', sourceRevision: 2, sourceFinal: true, startMs: 50, endMs: 2150, speaker: '发言人' }] };
  delete remote.audioBlob;
  f.runtime.listRecordings = async () => [remote];
  await f.page.initializeRuntime(); await f.page.openRecording(id);
  const row = f.page.data.rows[0];
  assert.equal(row.source, '未同步的手工正文'); assert.equal(row.providerSource, '服务端最终正文');
  assert.equal(row.contentConflict, true); assert.equal(row.sourceRevision, 2); assert.equal(row.baseSourceRevision, 1);
  assert.equal(f.page.record.audioBlob.size, 4);
});

test('clicking a segment timestamp seeks the actual audio without playing or opening the editor', async () => {
  const f = await fixture(); await capture(f);
  f.page.seekSegment({ currentTarget: { dataset: { id: 'seg-1' } } });
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'seekSeconds'), [['seekSeconds', 0.1]]);
  assert.equal(f.calls.filter(call => call === 'play').length, 0);
  assert.equal(f.page.data.running, false);
  f.page.record.segments[0].startMs = null; f.page.seekSegment('seg-1');
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'seekSeconds').length, 1);
  assert.match(f.page.data.notice, /尚未提供时间/);
});

test('speaker recognition preserves the transcript until explicitly applying the preview', async () => {
  const f = await fixture(); await capture(f);
  f.page.data.capabilities.speakers = true;
  f.runtime.saveRecording = async () => ({ saved: true, contentVersion: 'latest-content' });
  f.runtime.identifySpeakers = async () => ({ job: { status: 'pending' } });
  f.runtime.getSpeakers = async () => ({ job: { status: 'ready', speakerCount: 2, segmentCount: 2,
    preview: [{ speaker: '发言人 1', text: '新的分离结果', startMs: 100 }] } });
  await f.page.requestSpeakers();
  assert.equal(f.page.data.speakerJobStatus, 'pending');
  assert.equal(f.page.record.segments[0].source, '今天讨论项目安排。');
  assert.equal(f.page.record.speakerDiarization, false);
  await f.page.refreshSpeakers();
  assert.equal(f.page.data.speakerJobStatus, 'ready');
  assert.match(f.page.data.speakerJobMessage, /2 位发言人/);
  assert.equal(f.page.record.segments.length, 1);
  let request;
  f.runtime.applySpeakers = async value => {
    request = value;
    return { recording: { ...structuredClone(f.page.record), sourceVersion: 'file-job', speakerDiarization: true,
      speakerJob: { status: 'applied' }, segments: [{ id: 'file-one', source: '新的分离结果', speaker: '发言人 1',
        startMs: 100, endMs: 2000, sourceFinal: true, sourceRevision: 0 }] } };
  };
  await f.page.applySpeakerResult();
  assert.equal(request.expectedContentVersion, 'latest-content');
  assert.equal(f.page.record.segments.length, 1);
  assert.equal(f.page.record.segments[0].id, 'file-one');
  assert.equal(f.page.record.speakerDiarization, true);
  assert.equal(f.records.get(f.page.record.id).sourceVersion, 'file-job');
  assert.equal(f.page.record.audioBlob.size, 4);
  assert.equal(f.timers.size, 0);
});

test('unsynced edits prevent speaker submission and application', async () => {
  const f = await fixture(); await capture(f);
  f.page.data.capabilities.speakers = true;
  let submissions = 0, applications = 0;
  f.runtime.saveRecording = async () => { throw new Error('offline'); };
  f.runtime.identifySpeakers = async () => { submissions++; };
  f.runtime.applySpeakers = async () => { applications++; };
  await f.page.requestSpeakers();
  assert.equal(submissions, 0); assert.match(f.page.data.notice, /同步/);
  f.page.record.speakerJob = { status: 'ready' };
  await f.page.applySpeakerResult();
  assert.equal(applications, 0); assert.equal(f.page.record.segments[0].source, '今天讨论项目安排。');
});

test('new source versions never concatenate with unsent edits from the old transcript', async () => {
  const f = await fixture(); await capture(f);
  seedPendingEdit(f, '未同步的手工修订');
  const id = f.page.record.id;
  f.runtime.listRecordings = async () => [{ ...structuredClone(f.page.record), localPending: false,
    sourceVersion: 'file-job', speakerDiarization: true, segments: [{ id: 'file-one', source: '录后原稿',
      speaker: '发言人 1', sourceRevision: 0, startMs: 0, endMs: 2200 }] }];
  await f.page.initializeRuntime(); await f.page.openRecording(id);
  assert.equal(f.page.record.segments.length, 1);
  assert.equal(f.page.record.segments[0].source, '未同步的手工修订');
  assert.equal(f.page.record.localSourceConflict, true);
  assert.match(f.page.data.speakerJobMessage, /未同步的内容仍保留/);
});

test('late speaker polling cannot update a different recording', async () => {
  const f = await fixture(); await capture(f);
  let resolve;
  f.runtime.getSpeakers = () => new Promise(done => { resolve = done; });
  const pending = f.page.refreshSpeakers(true);
  await f.page.newRecording();
  resolve({ job: { status: 'ready', speakerCount: 2 } });
  await pending;
  assert.equal(f.page.record.speakerJob.status, 'idle');
  assert.equal(f.page.record.segments.length, 0);
});


test('document progress reopens from server and late responses cannot replace another recording', async () => {
  const f = await fixture(); await capture(f);
  f.page.data.capabilities.documents = true;
  let resolve;
  f.runtime.getDocument = () => new Promise(done => { resolve = done; });
  const pending = f.page.refreshDocument(true);
  await f.page.goBack(); await f.page.newRecording();
  const next = f.page.record.id;
  resolve({job:{status:'ready',url:'https://self.feishu.cn/docx/doc123'}});
  await pending;
  assert.equal(f.page.record.id, next);
  assert.equal(f.page.data.documentUrl, '');
});

test('document retry waits for saved edits and reports the existing job', async () => {
  const f = await fixture(); await capture(f);
  f.page.data.capabilities.documents = true;
  let submissions = 0;
  f.runtime.createDocument = async () => { submissions++; return {job:{status:'queued'}}; };
  await f.page.requestDocument();
  assert.equal(submissions, 0);
  f.runtime.saveRecording = async () => ({saved:true});
  f.runtime.getDocument = async () => ({job:{status:'ready',url:'https://self.feishu.cn/docx/doc123'}});
  await f.page.requestDocument(); await Promise.resolve();
  assert.equal(submissions, 1);
  assert.equal(f.page.data.documentUrl, 'https://self.feishu.cn/docx/doc123');
});


test('the summary title replaces a default title in the detail, the list and export names', async () => {
  const f = await fixture(); await capture(f);
  const id = f.page.record.id;
  f.page.data.capabilities.documents = true;
  assert.equal(f.page.data.summaryTitle, '');
  f.runtime.getDocument = async () => ({ job: { status: 'ready', url: 'https://self.feishu.cn/docx/doc123', title: '项目安排讨论' } });
  await f.page.refreshDocument(true);
  assert.equal(f.page.data.summaryTitle, '项目安排讨论');
  assert.equal(f.records.get(id).documentJob.title, '项目安排讨论');
  await f.page.exportFile({ currentTarget: { dataset: { format: 'txt' } } });
  assert.match(f.calls.find(call => Array.isArray(call) && call[0] === 'download')[2], /^项目安排讨论\.txt$/);
  await f.page.goBack();
  assert.equal(f.page.data.records[0].summaryTitle, '项目安排讨论');
  // A title the user chose is never replaced.
  const named = f.records.get(id); named.title = '我的标题'; f.records.set(id, named);
  await f.page.loadLibrary();
  assert.equal(f.page.data.records[0].summaryTitle, '');
});

test('searching lists only the matching sentences, and a result opens in the full transcript', async () => {
  const f = await fixture(); await capture(f);
  f.page.record.segments = [
    { id: 'a', source: '先说预算。', sourceLanguage: 'zh', sourceFinal: true, startMs: 0 },
    { id: 'b', source: '然后讨论项目排期。', sourceLanguage: 'zh', sourceFinal: true, startMs: 4000 },
    { id: 'c', source: '项目下周上线。', sourceLanguage: 'zh', sourceFinal: true, startMs: 9000 }];
  f.page.renderRecord();
  f.page.toggleSearch();
  // An empty field still shows everything, without turning rows into results.
  assert.equal(f.page.data.rows.length, 3); assert.equal(f.page.data.searchResults, false);
  f.page.updateSearch(' 项目 ');
  assert.deepEqual(f.page.data.rows.map(row => row.id), ['b', 'c']);
  assert.equal(f.page.data.searchCount, 2); assert.equal(f.page.data.searchResults, true);
  f.page.updateSearch('没有的词');
  assert.equal(f.page.data.rows.length, 0); assert.equal(f.page.data.searchCount, 0);
  f.page.updateSearch('项目');
  f.page.openResult('c');
  assert.equal(f.page.data.searchOpen, false); assert.equal(f.page.data.searchQuery, '');
  assert.equal(f.page.data.rows.length, 3);
  assert.equal(f.page.data.scrollTarget, 'utt-c'); assert.equal(f.page.data.flashRow, 'c');
  // An unknown result id changes nothing.
  f.page.openResult('missing'); assert.equal(f.page.data.flashRow, 'c');
  clearTimeout(f.page.flashTimer);
});

test('a recording without a document says whether one is still coming', async () => {
  const f = await fixture(); await capture(f);
  const show = changes => { Object.assign(f.page.record, { documentJob: null }, changes); f.page.renderRecord(); return f.page.data.documentMessage; };
  // The document waits for the automatic full transcript; nothing to tap meanwhile.
  assert.equal(show({ state: 'stopped', fileModel: 'stepfun', speakerJob: { status: 'running' } }), '全文识别完成后会自动生成飞书文档。');
  assert.equal(f.page.data.transcribing, true);
  // A recording that broke off never gets one automatically.
  assert.equal(show({ state: 'error', fileModel: null, speakerJob: null }), '录音没有正常结束，没有自动生成飞书文档。');
  // One the service can still recognise says how to get its document.
  assert.match(show({ state: 'error', fileModel: null, speakerJob: null, fileAsrAvailable: true }), /可在“更多”里识别全文/);
  // An older finished recording without one can ask for it.
  assert.equal(show({ state: 'stopped', fileModel: null, speakerJob: null }), '还没有飞书文档，可以点“生成”。');
});

test('saved text revisions immediately identify the document as an older version', async () => {
  const f = await fixture(); await capture(f);
  f.runtime.saveRecording = async () => ({saved:true,documentJob:{status:'ready',stale:true,url:'https://self.feishu.cn/docx/doc123'}});
  await f.page.saveCurrent();
  assert.match(f.page.data.documentMessage, /文字已变动/);
  assert.equal(f.page.data.documentUrl, 'https://self.feishu.cn/docx/doc123');
  assert.equal(f.records.get(f.page.record.id).documentJob.stale, true);
});

test('the device tab bar connects first, then records, and device readings follow runtime events', async () => {
  const f = await fixture();
  assert.equal(f.page.data.tab, 'device'); assert.equal(f.page.data.device, null);
  f.runtime.connect = async request => { f.calls.push(['connect', request]); return { connected: true, device: { connected: true, micBattery: 80, readAt: '2026-11-02T05:00:00.000Z' } }; };
  await f.page.primaryAction();
  assert.equal(f.page.data.connected, true); assert.equal(f.page.data.device.micBattery, 80);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
  await f.page.primaryAction();
  assert.equal(f.page.data.view, 'detail'); assert.equal(f.page.data.captureState, 'waiting');
  const starts = () => f.calls.filter(call => Array.isArray(call) && call[0] === 'start').length;
  assert.equal(starts(), 1);
  await f.page.primaryAction();
  assert.equal(starts(), 1);
  f.emit({ type: 'device', device: { connected: false, micBattery: 70 } });
  assert.equal(f.page.data.connected, false); assert.equal(f.page.data.device.micBattery, 70);
});

test('tabs switch only in the library view, and a saved recording returns to the recordings tab', async () => {
  const f = await fixture();
  f.page.setTab('recordings'); assert.equal(f.page.data.tab, 'recordings');
  f.page.setTab('settings'); assert.equal(f.page.data.tab, 'recordings');
  f.page.setTab('device');
  await capture(f);
  assert.equal(f.page.data.view, 'detail'); assert.equal(f.page.data.tab, 'recordings');
  f.page.setTab('device'); assert.equal(f.page.data.tab, 'recordings');
  await f.page.goBack(); assert.equal(f.page.data.view, 'library'); assert.equal(f.page.data.tab, 'recordings');
  assert.equal(f.page.data.records[0].dayText, '今天');
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) };
}

test('opening reconnects a recorder used before on this phone, but never records', async () => {
  const storage = memoryStorage();
  const f = await fixture({ localStorage: storage, initDevice: { connected: false, micBattery: 80, readAt: '2026-11-02T05:00:00.000Z' } });
  assert.equal(JSON.stringify(f.calls.slice(0, 2)), JSON.stringify(['init', ['connect', {}]]));
  assert.equal(f.page.data.connected, true); assert.equal(f.page.data.notice, '');
  assert.equal(storage.values.get('minutes.autoconnect.v1'), '1');
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
  // 断开 stops the reconnect on the next opening.
  await f.page.releaseDevice();
  assert.equal(storage.values.get('minutes.autoconnect.v1'), '0'); assert.equal(f.page.data.connected, false);
  const again = await fixture({ localStorage: storage, initDevice: { connected: false, micBattery: 80 } });
  assert.deepEqual(again.calls, ['init']);
  // A phone that never connected stays idle.
  const fresh = await fixture({ localStorage: memoryStorage() });
  assert.deepEqual(fresh.calls, ['init']);
});

test('a failed automatic connection is reported quietly on the device tab', async () => {
  const f = await fixture({ localStorage: memoryStorage({ 'minutes.autoconnect.v1': '1' }), connectError: '未发现录音豆' });
  assert.equal(JSON.stringify(f.calls), JSON.stringify(['init', ['connect', {}]]));
  assert.equal(f.page.data.connected, false); assert.equal(f.page.data.notice, '');
  assert.match(f.page.data.runtimeStatus, /没连上录音豆：未发现录音豆/);
  f.page.setData({ busy: '' });
  await f.page.connectDevice();
  assert.equal(f.page.data.notice, '未发现录音豆');
});

test('the link stays after a saved recording and after cancelling, when the runtime keeps it', async () => {
  const f = await fixture(); let linked = false;
  f.runtime.device = () => ({ connected: linked });
  const connect = f.runtime.connect; f.runtime.connect = async request => { linked = true; return connect(request); };
  f.runtime.abort = async () => { f.calls.push('abort'); };
  await f.page.connectDevice(); await f.page.beginRecording();
  await f.page.cancelCapture();
  assert.ok(f.calls.includes('abort')); assert.equal(f.calls.includes('disconnect'), false);
  assert.equal(f.page.data.connected, true); assert.equal(f.page.data.view, 'library'); assert.equal(f.page.data.records.length, 0);
  await capture(f);
  assert.equal(f.page.data.captureState, 'stopped'); assert.equal(f.page.data.connected, true);
});

test('recordings on the recorder are listed, picked by the user and deleted only after confirming', async () => {
  const f = await fixture();
  await f.page.connectDevice();
  let onDevice = [{ fileId: 1793630175, durationMs: 60000 }, { fileId: 1793631900, durationMs: 40300 }, { fileId: 1793716800, durationMs: 9000 }];
  f.runtime.listDeviceFiles = async () => ({ active: 1793716800, files: onDevice.map(file => ({ ...file })) });
  f.runtime.listRecordings = async () => [{ id: 'rec-a', sourceIdentity: { fileId: 1793631900 } }];
  const deleted = [];
  f.runtime.deleteDeviceFiles = async request => { deleted.push(...request.fileIds); onDevice = onDevice.filter(file => !request.fileIds.includes(file.fileId)); return { deleted: request.fileIds.length }; };
  await f.page.openDeviceFiles();
  assert.equal(f.page.data.view, 'files');
  // Newest first; the one being recorded is shown but cannot be picked.
  assert.equal(JSON.stringify(f.page.data.deviceFiles.map(file => [file.fileId, file.active, file.saved])),
    JSON.stringify([[1793716800, true, false], [1793631900, false, true], [1793630175, false, false]]));
  f.page.toggleDeviceFile('1793716800'); assert.equal(f.page.data.deviceFilesSelected.length, 0);
  f.page.toggleAllDeviceFiles(); assert.equal(JSON.stringify([...f.page.data.deviceFilesSelected].sort()), JSON.stringify(['1793630175', '1793631900']));
  f.page.toggleAllDeviceFiles(); assert.equal(f.page.data.deviceFilesSelected.length, 0);
  f.page.toggleDeviceFile('1793630175');
  // Nothing is deleted before the confirmation.
  f.page.askDeleteDeviceFiles(); assert.equal(f.page.data.deleteOpen, true); assert.deepEqual(deleted, []);
  f.page.closeSheets(); assert.equal(f.page.data.deleteOpen, false); assert.deepEqual(deleted, []);
  f.page.askDeleteDeviceFiles(); await f.page.confirmDeleteDeviceFiles();
  assert.deepEqual(deleted, [1793630175]);
  assert.match(f.page.data.notice, /删除 1 段/);
  assert.equal(JSON.stringify(f.page.data.deviceFiles.map(file => file.fileId)), JSON.stringify([1793716800, 1793631900]));
  assert.equal(f.page.data.deviceFilesSelected.length, 0);
  // What the recorder refused is said, not reported as deleted.
  f.runtime.deleteDeviceFiles = async () => ({ deleted: 0, failed: [1793631900] });
  f.page.toggleDeviceFile('1793631900'); f.page.askDeleteDeviceFiles(); await f.page.confirmDeleteDeviceFiles();
  assert.equal(f.page.data.notice, '1 段录音豆没有确认删除，可以再试一次');
  f.page.closeDeviceFiles(); assert.equal(f.page.data.view, 'library'); assert.equal(f.page.data.tab, 'device');
  // A failed read says so instead of showing an empty recorder.
  f.runtime.listDeviceFiles = async () => { throw new Error('录音豆没有回应，请稍后再试'); };
  await f.page.openDeviceFiles();
  assert.equal(f.page.data.deviceFilesError, '录音豆没有回应，请稍后再试'); assert.equal(f.page.data.deviceFiles.length, 0);
});

test('a recording the phone stopped receiving is flagged until the recorder ends it', async () => {
  const f = await fixture();
  await f.page.connectDevice();
  f.emit({ type: 'recorder', recording: true, unreceived: true });
  assert.equal(f.page.data.recorderUnreceived, true);
  f.emit({ type: 'recorder', recording: false, unreceived: false });
  assert.equal(f.page.data.recorderUnreceived, false);
});

test('pressing the physical key while connected starts a recording without tapping', async () => {
  const f = await fixture();
  await f.page.connectDevice();
  const starts = () => f.calls.filter(call => Array.isArray(call) && call[0] === 'start').length;
  f.emit({ type: 'device_recording', fileId: 7 }); await new Promise(resolve => setImmediate(resolve));
  // Already recording on the device: no "press the key" waiting screen, and the file is named.
  assert.equal(starts(), 1); assert.equal(f.page.data.view, 'detail'); assert.equal(f.page.data.captureState, 'recording');
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'start')[1].fileId, 7);
  // A late "waiting" status never sends a started recording back to the waiting screen.
  f.emit({ type: 'status', phase: 'waiting', message: '请按录音豆实体键开始录音', recordingId: f.page.record.id });
  assert.equal(f.page.data.captureState, 'recording');
  // A second detection during a capture is ignored.
  f.emit({ type: 'device_recording', fileId: 7 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts(), 1);
  await f.page.stopCapture();
  // A press that arrives while the last recording is still saving starts right after.
  // (This fixture runtime does not keep links, so mark it still connected.)
  f.page.setData({ busy: 'save', connected: true });
  f.emit({ type: 'device_recording', fileId: 8 });
  assert.equal(starts(), 1);
  f.page.setData({ busy: '' }); await f.page.maybeAutoStart();
  assert.equal(starts(), 2);
  // Without a connection nothing starts.
  const g = await fixture();
  g.emit({ type: 'device_recording', fileId: 9 });
  assert.equal(g.calls.some(call => Array.isArray(call) && call[0] === 'start'), false);
});

test('the play button follows the audio element even when no playing event arrives', async () => {
  const f = await fixture(); await capture(f);
  let paused = true;
  f.page.host.paused = () => paused;
  f.page.host.play = async () => { f.calls.push('play'); paused = false; };
  f.page.host.pause = () => { f.calls.push('pause'); paused = true; };
  await f.page.togglePlayback();
  assert.equal(f.page.data.running, true);
  // No 'playing' event: the time update still reports the element as playing.
  f.page.onAudioTime({ currentTime: 2, duration: 112, paused: false, ended: false });
  assert.equal(f.page.data.running, true);
  const before = f.calls.length;
  await f.page.togglePlayback();
  assert.deepEqual(f.calls.slice(before), ['pause']); assert.equal(paused, true);
  assert.equal(f.page.data.running, false);
  f.page.onAudioTime({ currentTime: 112, duration: 112, paused: true, ended: true });
  assert.equal(f.page.data.running, false);
});

test('realtime and post modes pick their models, fall back to StepFun, and are remembered', async () => {
  const storage = memoryStorage();
  const f = await fixture({ localStorage: storage });
  const starts = () => f.calls.filter(call => Array.isArray(call) && call[0] === 'start').map(call => JSON.parse(JSON.stringify(call[1])));
  // Doubao is not configured in this fixture: the realtime choice falls back to StepFun.
  await f.page.connectDevice(); await f.page.beginRecording();
  assert.equal(starts()[0].liveModel, 'stepfun'); assert.equal(starts()[0].fileModel, 'stepfun');
  await f.page.cancelCapture();
  f.page.data.capabilities.models = { stepfun: true, doubao: true };
  f.page.setAsrMode('post'); f.page.setFileModel('doubao');
  assert.deepEqual(JSON.parse(storage.values.get('minutes.asr.v1')), { asrMode: 'post', liveModel: 'doubao', fileModel: 'doubao' });
  f.page.setData({ captureState: 'idle', busy: '' }); f.page.captureId = null;
  await f.page.connectDevice(); await f.page.beginRecording();
  const post = starts().pop();
  assert.equal(post.liveModel, 'none'); assert.equal(post.fileModel, 'doubao');
  assert.equal(f.page.data.recordAsrMode, 'post');
  const again = await fixture({ localStorage: storage });
  assert.equal(again.page.data.asrMode, 'post'); assert.equal(again.page.data.fileModel, 'doubao');
});

test('an automatically applied file transcript replaces the realtime text and keeps the local audio', async () => {
  const f = await fixture(); await capture(f);
  const id = f.page.record.id; f.page.record.fileModel = 'stepfun';
  const audio = f.page.record.audioBlob;
  f.page.renderRecord();
  assert.equal(f.page.data.transcribing, true);
  f.runtime.getSpeakers = async () => ({ job: { status: 'applied', speakerCount: 2, segmentCount: 2 } });
  f.runtime.getRecording = async () => ({ id, title: f.page.record.title, state: 'stopped', durationMs: 2200, speakerDiarization: true, sourceVersion: 'j1',
    audioUrl: '/api/audio/test', fileModel: 'stepfun', speakerJob: { status: 'applied' },
    segments: [{ id: 'file-j1-0', source: '甲的话', speaker: '发言人 1', startMs: 0, endMs: 900, sourceFinal: true, sourceRevision: 0 },
      { id: 'file-j1-1', source: '乙的话', speaker: '发言人 2', startMs: 1000, endMs: 2000, sourceFinal: true, sourceRevision: 0 }] });
  await f.page.refreshSpeakers(true);
  assert.deepEqual(f.page.record.segments.map(row => row.speaker), ['发言人 1', '发言人 2']);
  assert.equal(f.page.record.audioBlob, audio);
  assert.equal(f.page.data.transcribing, false); assert.equal(f.page.data.speakerCount, 2);
  assert.equal(f.records.get(id).segments.length, 2);
});


async function settle(rounds = 5) { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); }
const startCalls = f => f.calls.filter(call => Array.isArray(call) && call[0] === 'start').map(call => call[1]);

test('a key press seen while the page is busy starts once it is free, and never becomes a phantom recording', async () => {
  const f = await fixture(); f.runtime.device = () => ({ connected: true });
  await capture(f);
  // Busy with a translation when the physical key is pressed: nothing can start yet.
  let release; f.runtime.translate = () => new Promise(resolve => { release = resolve; });
  const translating = f.page.requestTranslation();
  f.emit({ type: 'device_recording', fileId: 7 });
  assert.equal(startCalls(f).length, 1);
  release({ translations: [{ id: 'seg-1', text: 'Discuss the project plan.', language: 'en' }] });
  await translating; await settle();
  assert.equal(startCalls(f).length, 2); assert.equal(startCalls(f)[1].fileId, 7); assert.equal(f.page.data.captureState, 'recording');
  await f.page.stopCapture(); await settle();
  assert.equal(startCalls(f).length, 2);
  // A press noticed while a manual start is on its way is that same recording,
  // so it is not started again once that recording is saved.
  const start = f.runtime.start;
  f.runtime.start = async request => { f.emit({ type: 'device_recording', fileId: 8 }); return start.call(f.runtime, request); };
  await f.page.goBack(); await f.page.primaryAction();
  assert.equal(startCalls(f).length, 3); assert.equal(startCalls(f)[2].fileId, undefined); assert.equal(f.page.data.captureState, 'waiting');
  f.runtime.start = start;
  f.emit({ type: 'status', phase: 'recording', recordingId: f.page.record.id, message: '录音豆正在录音，正在接收…' });
  await f.page.stopCapture(); await settle();
  assert.equal(startCalls(f).length, 3); assert.equal(f.page.data.captureState, 'stopped');
  // A press older than the window is dropped (the runtime reports a recording still running afresh).
  f.page.setData({ busy: 'document' });
  f.emit({ type: 'device_recording', fileId: 9 });
  f.page.deviceRecordingPending.at -= 16000;
  f.page.endBusy(); await settle();
  assert.equal(startCalls(f).length, 3); assert.equal(f.page.deviceRecordingPending, null);
  // A detection without its file is never shown as recording: the start waits for the key.
  f.emit({ type: 'device_recording' }); await settle();
  assert.equal(startCalls(f).length, 4); assert.equal(startCalls(f)[3].fileId, undefined);
  assert.equal(f.page.data.captureState, 'waiting'); assert.equal(f.page.record.state, 'waiting');
  // Losing the link drops a press that was waiting.
  await f.page.cancelCapture();
  f.page.setData({ busy: 'speakers' }); f.emit({ type: 'device_recording', fileId: 10 });
  f.emit({ type: 'device', device: { connected: false } });
  f.page.endBusy(); await settle();
  assert.equal(startCalls(f).length, 4); assert.equal(f.page.deviceRecordingPending, null);
});

test('the service sync of a finished recording neither holds back the next key press nor leaves it unmarked', async () => {
  const f = await fixture(); f.runtime.device = () => ({ connected: true });
  let releasePost = null;
  f.runtime.saveRecording = snapshot => snapshot.state === 'stopped' && !releasePost
    ? new Promise(resolve => { releasePost = () => resolve({ saved: true, contentVersion: 'v-first' }); }) : Promise.resolve({ saved: true });
  await capture(f);
  const first = f.page.record.id;
  assert.equal(f.page.data.busy, ''); assert.equal(f.page.data.status, '录音与文字已保存');
  assert.equal(f.records.get(first).state, 'stopped'); assert.equal(f.records.get(first).localPending, true);
  f.emit({ type: 'device_recording', fileId: 7 }); await settle();
  assert.equal(startCalls(f).length, 2); assert.notEqual(f.page.record.id, first);
  assert.equal(f.records.get(f.page.record.id).state, 'recording');
  releasePost(); await f.page.syncQueue; await settle();
  assert.equal(f.records.get(first).serverSaved, true); assert.equal(f.records.get(first).localPending, false);
  assert.equal(f.records.get(first).contentVersion, 'v-first');
  assert.notEqual(f.page.record.contentVersion, 'v-first');
});

test('the phone copy of saved audio arrives later and is kept, even after the page moved on', async () => {
  const f = await fixture(); f.runtime.device = () => ({ connected: true });
  const urlOnly = { ...f.result, audio: { url: '/api/audio/test', mimeType: 'audio/wav' } };
  f.runtime.stop = async () => { f.calls.push('stop'); return urlOnly; };
  await capture(f);
  const first = f.page.record.id;
  assert.equal(f.page.data.captureState, 'stopped'); assert.equal(f.page.record.audioBlob, null);
  assert.match(f.page.data.saveStatus, /音频来自私有服务/);
  f.emit({ type: 'audio_cached', recordingId: first, url: '/api/audio/test', blob: new Blob(['wave'], { type: 'audio/wav' }) });
  await settle();
  assert.equal(f.page.record.audioBlob.size, 4); assert.equal(f.records.get(first).audioBlob.size, 4);
  assert.match(f.page.data.saveStatus, /音频与文字已缓存本机/);
  // The next recording has begun when the previous one's copy arrives.
  await f.page.goBack(); await f.page.beginRecording();
  const second = f.page.record.id;
  await f.page.stopCapture(); await f.page.goBack(); await f.page.beginRecording();
  f.emit({ type: 'audio_cached', recordingId: second, url: '/api/audio/test', blob: new Blob(['second'], { type: 'audio/wav' }) });
  await settle();
  assert.notEqual(f.page.record.id, second); assert.equal(f.records.get(second).audioBlob.size, 6);
  assert.equal(f.page.record.audioBlob, null);
});

test('a document poll never writes an older stored copy over a newer save', async () => {
  let hold = null;
  const f = await fixture({ holdGet: () => hold });
  f.page.data.capabilities.documents = true;
  await capture(f);
  const id = f.page.record.id;
  f.runtime.getDocument = async () => ({ job: { status: 'writing' } });
  let release; hold = new Promise(resolve => { release = resolve; });
  // A slow read for the poll starts before the translation is saved...
  const polling = f.page.refreshDocument(true);
  await settle();
  hold = null;
  const translating = f.page.requestTranslation();
  await settle();
  release(); await polling; await translating; await settle();
  // ...and neither write undoes the other.
  assert.equal(f.records.get(id).segments[0].translation, 'Discuss the project plan.');
  assert.equal(f.records.get(id).documentJob.status, 'writing');
  f.page.stopDocumentPolling();
});
