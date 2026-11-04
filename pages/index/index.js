var recordings = require('../../lib/recording-store');
var SPEEDS = [1, 1.5, 2];
var MODES = ['both', 'zh', 'en'];
var ACTIVE = ['waiting', 'recording', 'finishing'];
var AUTO_TITLE = /^录音 \d{4}\/\d{1,2}\/\d{1,2}/;
// An untouched default title gives way to the short title written with the summary.
// Opening the page reconnects a recorder used before on this phone, until the
// user taps 断开; that choice holds until the next manual connection.
var AUTO_CONNECT_KEY = 'minutes.autoconnect.v1';
// Realtime shows captions while recording; post records audio only. Both run a
// file model afterwards to settle the full text and tell speakers apart.
var ASR_KEY = 'minutes.asr.v1', ASR_MODES = ['live', 'post'], LIVE_MODELS = ['doubao', 'stepfun'], FILE_MODELS = ['stepfun', 'doubao'];
var ACTIVE_JOBS = ['submitting', 'pending', 'running'];
// A key press the page could not take up at once is started within this
// window (the runtime's prepared key lasts as long); after it the recorder is
// watched again and a recording still running is reported afresh.
var PRESS_WINDOW_MS = 15000;
function asrChoice(storage) {
  var value = {};
  try { value = JSON.parse(storage && storage.getItem(ASR_KEY) || '{}') || {}; } catch (_) { value = {}; }
  return { asrMode: ASR_MODES.includes(value.asrMode) ? value.asrMode : 'live', liveModel: LIVE_MODELS.includes(value.liveModel) ? value.liveModel : 'doubao',
    fileModel: FILE_MODELS.includes(value.fileModel) ? value.fileModel : 'stepfun' };
}
function preference(storage) { try { return storage ? storage.getItem(AUTO_CONNECT_KEY) : null; } catch (_) { return null; } }
function remember(storage, value) { try { if (storage) storage.setItem(AUTO_CONNECT_KEY, value); } catch (_) {} }
function rememberAsr(storage, data) { try { if (storage) storage.setItem(ASR_KEY, JSON.stringify({ asrMode: data.asrMode, liveModel: data.liveModel, fileModel: data.fileModel })); } catch (_) {} }
function summaryTitle(record) { var job = record.documentJob || {}; return AUTO_TITLE.test(record.title || '') && typeof job.title === 'string' ? job.title : ''; }
function stamp(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : ''; }
function clock(value) { var date = new Date(value); return Number.isFinite(date.getTime()) ? date.toTimeString().slice(0, 5) : ''; }
function dayLabel(value) {
  var date = new Date(value); if (!Number.isFinite(date.getTime())) return '更早';
  var today = new Date(), start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime(), day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === start) return '今天';
  if (day === start - 86400000) return '昨天';
  return (date.getFullYear() === today.getFullYear() ? '' : date.getFullYear() + '年') + (date.getMonth() + 1) + '月' + date.getDate() + '日';
}
function originLabel(record) { return record.sourceType === 'live_device' ? '录音豆现场接收' : record.sourceType ? '已有录音回放 · 非现场录制' : '录音来源未标明'; }
function savedLabel(record) { return record.state === 'draft' ? '草稿已在本机保存' : record.audioBlob || record.hasAudioBlob ? '音频与文字已缓存本机' + (record.serverSaved ? ' · 私有服务已保存' : '') : record.audioUrl ? '文字已缓存本机 · 音频来自私有服务' : record.segments.length ? '文字已在本机保存' : '录音信息已在本机保存'; }
function parts(text, query) {
  if (!query) return [{ key: '0', text: text, match: false }];
  var result = [], start = 0, lower = text.toLowerCase(), needle = query.toLowerCase(), found;
  while ((found = lower.indexOf(needle, start)) !== -1) {
    if (found > start) result.push({ key: String(result.length), text: text.slice(start, found), match: false });
    result.push({ key: String(result.length), text: text.slice(found, found + query.length), match: true }); start = found + query.length;
  }
  if (start < text.length) result.push({ key: String(result.length), text: text.slice(start), match: false });
  return result;
}
function valueOf(event) { return event && event.detail ? event.detail.value : event; }
function dataOf(event, key) { return event && event.currentTarget ? event.currentTarget.dataset[key] : event; }
Page({
  data: {
    view: 'library', tab: 'device', records: [], loading: true, initialized: false, connected: false, sessionOpen: false, busy: '', captureState: 'idle', language: 'zh',
    status: '正在打开本地录音库…', runtimeStatus: '', sourceLabel: 'soundcore Work', capabilities: {}, devices: [], device: null,
    title: '', dateLabel: '', createdAt: '', recordingId: '', rows: [], speakerCount: 0, displayMode: 'both', translationMissing: 0,
    running: false, elapsed: '00:00', duration: '00:00', progress: 0, speed: 1, hasAudio: false,
    speakerJobStatus: 'idle', speakerJobMessage: '', speakerPreview: [],
    documentStatus: 'idle', documentMessage: '', documentUrl: '',
    saved: false, saveStatus: '', syncFailed: false, durationMs: 0, summaryTitle: '', asrMode: 'live', liveModel: 'doubao', fileModel: 'stepfun', recordAsrMode: 'live', transcribing: false, fileJobError: '', originLabel: '', searchOpen: false, searchQuery: '', searchCount: 0, searchResults: false, scrollTarget: '', flashRow: '',
    translationStatus: 'idle', optionsOpen: false, notice: '', error: '', recorderUnreceived: false,
    deviceFiles: [], deviceFilesLoading: false, deviceFilesError: '', deviceFilesSelected: [], deleteOpen: false
  },
  onLoad: async function () {
    var environment = typeof window !== 'undefined' ? window : (typeof getApp === 'function' ? getApp() : {});
    this.runtime = environment.MinutesRuntime || environment.minutesRuntime || null;
    try { this.storage = environment.localStorage || null; } catch (_) { this.storage = null; }
    this.setData(asrChoice(this.storage));
    this.host = environment.MinutesHost || environment.minutesHost || null;
    this.store = environment.MinutesStore || environment.minutesStore || recordings.createStore();
    this.record = null; this.captureId = null; this.saveQueue = Promise.resolve(); this.saveTimer = null; this.saveVersion = 0; this.saveNotice = null; this.audioKey = null;
    // The newest save per recording: an older one finishing later never writes over it.
    this.saveLatest = {}; this.deviceRecordingPending = null; this.deviceTriggered = null;
    if (this.runtime && typeof this.runtime.subscribe === 'function') this.unsubscribe = this.runtime.subscribe(this.onRuntimeEvent.bind(this));
    await Promise.all([this.loadLibrary(), this.initializeRuntime()]);
    this.setData({ loading: false });
    if (this.runtime && this.runtime.initialRecordingId) await this.openRecording(this.runtime.initialRecordingId);
    await this.autoConnect();
  },
  initializeRuntime: async function () {
    if (!this.runtime) { this.setData({ runtimeStatus: '此宿主尚未接入录音豆运行时', initialized: false }); return; }
    try {
      var result = await this.runtime.init();
      this.setData({ initialized: true, capabilities: result.capabilities || {}, connected: !!result.connected, device: result.device || null,
        sourceLabel: result.sourceLabel || 'soundcore Work', runtimeStatus: result.connected ? '录音豆已连接' : '连接录音豆后开始接收' });
      if (typeof this.runtime.listRecordings === 'function') {
        try {
          var remote = await this.runtime.listRecordings(), local = await this.store.list();
          var items = Array.isArray(remote) ? remote : (remote.recordings || []);
          for (var i = 0; i < items.length; i++) {
            var existing = local.find(function (item) { return item.id === items[i].id; });
            if (!existing || items[i].state === 'stopped' || (!existing.localPending && Date.parse(items[i].updatedAt) > Date.parse(existing.updatedAt))) {
              var cached = existing ? await this.store.get(existing.id) : null;
              var restored = items[i];
              if (cached && cached.localPending) {
                if ((cached.sourceVersion || 'stream') !== (items[i].sourceVersion || 'stream')) {
                  // Keep unsent local changes intact when another page selects a
                  // new transcript; never concatenate two different versions.
                  restored = Object.assign({}, cached, { localSourceConflict: true });
                } else {
                  restored = recordings.mergeSegments(cached, items[i].segments);
                  ['state', 'durationMs', 'audioUrl', 'audioMimeType', 'sourceType', 'sourceLabel', 'silenceRanges', 'speakerJob', 'speakerDiarization', 'contentVersion', 'sourceVersion', 'documentJob'].forEach(function (key) { if (items[i][key] !== undefined) restored[key] = items[i][key]; });
                }
              }
              await this.store.save(Object.assign({}, restored, { serverSaved: true, localPending: !!(cached && cached.localPending),
                audioBlob: cached && cached.audioBlob || null, hasAudioBlob: !!(cached && cached.audioBlob) }));
            }
          }
          await this.loadLibrary();
        } catch (syncError) { this.setData({ runtimeStatus: '本地录音库可用；服务列表未同步：' + syncError.message }); }
      }
    } catch (error) { this.setData({ initialized: false, runtimeStatus: error.message || '服务暂不可用' }); }
  },
  loadLibrary: async function () {
    try {
      // A draft or attempt that ended before any audio or text arrived carries
      // nothing to review; it stays in local storage but not in the list.
      var items = (await this.store.list()).filter(function (item) {
        return item.state === 'stopped' || (item.segments && item.segments.length) || item.audioBlob || item.hasAudioBlob || item.durationMs > 0;
      });
      this.setData({ records: items.map(function (item) { var job = item.documentJob || {};
        return Object.assign({}, item, { dateText: stamp(item.createdAt), dayText: dayLabel(item.createdAt), timeText: clock(item.createdAt), durationText: recordings.timeLabel(item.durationMs),
          stateText: item.state === 'stopped' ? (job.status === 'ready' ? '飞书文档已生成' : '已保存') : (item.state === 'draft' ? '待录音' : '未完成'), documentReady: job.status === 'ready',
          originLabel: originLabel(item), summaryTitle: summaryTitle(item), previewText: item.segments && item.segments.length ? item.segments[0].source : '暂无文字记录' }); }),
        status: items.length ? '录音保存在当前设备' : '还没有录音', error: '' });
    } catch (error) { this.setData({ error: error.message, status: '本地录音库无法读取' }); }
  },
  // Recordings kept on the recorder itself. Nothing is deleted unless the
  // user picks the files and confirms; the one being recorded cannot be picked.
  openDeviceFiles: async function () {
    if (!this.data.connected || this.isCapturing() || this.data.busy) { this.setData({ notice: '请先连接录音豆，并结束正在进行的录音' }); return; }
    this.setData({ view: 'files', deviceFiles: [], deviceFilesSelected: [], deviceFilesError: '', deleteOpen: false, notice: '' });
    await this.loadDeviceFiles();
  },
  loadDeviceFiles: async function () {
    if (!this.runtime || typeof this.runtime.listDeviceFiles !== 'function') { this.setData({ deviceFilesError: '当前环境不能读取录音豆里的文件' }); return; }
    this.setData({ deviceFilesLoading: true, deviceFilesError: '' });
    try {
      var listing = await this.runtime.listDeviceFiles(), saved = {};
      // A file this app already received is marked, so deleting it here loses nothing of what was kept.
      try { ((await this.runtime.listRecordings()) || []).forEach(function (record) { var source = record && record.sourceIdentity; if (source && source.fileId) saved[source.fileId] = true; }); } catch (_) {}
      var files = (listing.files || []).slice().sort(function (a, b) { return b.fileId - a.fileId; }).map(function (file) {
        // File ids are the recorder's start time in seconds; an unset clock gives no usable date.
        var at = file.fileId > 1577836800 ? file.fileId * 1000 : null;
        return { id: String(file.fileId), fileId: file.fileId, dayText: at ? dayLabel(at) : '时间未知', timeText: at ? clock(at) : '',
          durationMs: file.durationMs || 0, saved: !!saved[file.fileId], active: !!listing.active && file.fileId === listing.active };
      });
      var keep = this.data.deviceFilesSelected.filter(function (id) { return files.some(function (file) { return file.id === id && !file.active; }); });
      this.setData({ deviceFiles: files, deviceFilesSelected: keep, deviceFilesLoading: false });
    } catch (error) { this.setData({ deviceFilesLoading: false, deviceFilesError: error.message }); }
  },
  toggleDeviceFile: function (event) {
    var id = String(dataOf(event, 'deviceFile') || ''), file = this.data.deviceFiles.find(function (item) { return item.id === id; });
    if (!file || file.active || this.data.busy) return;
    var picked = this.data.deviceFilesSelected, next = picked.indexOf(id) === -1 ? picked.concat(id) : picked.filter(function (item) { return item !== id; });
    this.setData({ deviceFilesSelected: next });
  },
  toggleAllDeviceFiles: function () {
    if (this.data.busy) return;
    var all = this.data.deviceFiles.filter(function (file) { return !file.active; }).map(function (file) { return file.id; });
    this.setData({ deviceFilesSelected: this.data.deviceFilesSelected.length === all.length ? [] : all });
  },
  askDeleteDeviceFiles: function () { if (this.data.deviceFilesSelected.length && !this.data.busy) this.setData({ deleteOpen: true }); },
  confirmDeleteDeviceFiles: async function () {
    var ids = this.data.deviceFilesSelected.slice();
    if (!ids.length || this.data.busy) return;
    this.setData({ busy: 'delete', deleteOpen: false, notice: '' });
    try {
      var result = await this.runtime.deleteDeviceFiles({ fileIds: ids.map(Number) });
      var count = result && Number.isInteger(result.deleted) ? result.deleted : ids.length, refused = result && Array.isArray(result.failed) ? result.failed.length : 0;
      this.setData({ deviceFilesSelected: [], notice: refused ? (count ? '已删除 ' + count + ' 段；' : '') + refused + ' 段录音豆没有确认删除，可以再试一次' : '已从录音豆删除 ' + count + ' 段录音' });
    } catch (error) { this.setData({ notice: error.message }); }
    finally { this.setData({ busy: '' }); }
    await this.loadDeviceFiles();
    // A key press during the delete starts once the list is read again.
    this.maybeAutoStart();
  },
  closeDeviceFiles: function () { if (this.data.busy !== 'delete') this.setData({ view: 'library', tab: 'device', deleteOpen: false, deviceFilesSelected: [] }); },
  setTab: function (event) { var name = dataOf(event, 'tab'); if (['device', 'recordings'].includes(name) && this.data.view === 'library') this.setData({ tab: name, notice: '' }); },
  // The device tab's single bar walks the whole flow: connect, then record.
  primaryAction: function () {
    if (this.data.busy || this.isCapturing()) return;
    return this.data.connected ? this.beginRecording() : this.connectDevice();
  },
  // Pressing the physical key while connected starts a recording here too; if
  // the page is busy, it starts as soon as that ends (every place busy ends
  // calls this). A press older than PRESS_WINDOW_MS is dropped: the runtime
  // watches again and reports a recording that is still running.
  maybeAutoStart: function () {
    var pending = this.deviceRecordingPending;
    if (!pending) return;
    if (!(Date.now() - pending.at <= PRESS_WINDOW_MS)) { this.deviceRecordingPending = null; return; }
    if (!this.data.connected || this.isCapturing() || this.data.busy) return;
    this.deviceRecordingPending = null; this.deviceTriggered = pending;
    return this.beginRecording();
  },
  endBusy: function (patch) { this.setData(Object.assign({ busy: '' }, patch || {})); this.maybeAutoStart(); },
  beginRecording: async function () {
    if (this.data.busy || this.isCapturing()) return;
    if (!this.data.connected) { this.setData({ notice: '请先连接录音豆' }); return; }
    await this.newRecording();
    if (this.record && this.record.state === 'draft') await this.startCapture();
  },
  newRecording: async function () {
    if (this.isCapturing() || this.data.busy) { this.setData({ notice: '请先完成当前操作' }); return; }
    if (this.host) this.host.pause();
    this.stopSpeakerPolling(); this.stopDocumentPolling();
    this.record = recordings.createRecord({ sourceLabel: this.data.sourceLabel, language: this.data.language });
    this.audioKey = null;
    this.setData({ view: 'detail', captureState: 'draft', running: false, progress: 0, elapsed: '00:00', optionsOpen: false,
      searchOpen: false, searchQuery: '', notice: '', error: '', status: this.data.connected ? '已连接，点击开始接收' : '请先连接录音豆', saved: false });
    this.renderRecord(); await this.saveCurrent();
  },
  openRecording: async function (event) {
    if (this.isCapturing() || this.data.busy) { this.setData({ notice: '请先完成当前操作或断开接收连接' }); return; }
    try {
      var id = dataOf(event, 'id'), record = await this.store.get(id);
      if (!record && this.runtime && typeof this.runtime.getRecording === 'function') { record = await this.runtime.getRecording({ recordingId: id }); if (record) { record.serverSaved = true; await this.store.save(record); } }
      if (!record) throw new Error('未找到这条本地录音');
      if (this.host) this.host.pause();
      this.record = record; this.audioKey = null;
      if (record.translationStatus === 'loading') { record.translationStatus = 'error'; record.translationError = '上次翻译未完成，请重试'; }
      this.setData({ view: 'detail', tab: 'recordings', captureState: record.state, running: false, progress: 0, elapsed: '00:00', optionsOpen: false,
        searchOpen: false, searchQuery: '', notice: ACTIVE.indexOf(record.state) !== -1 ? '这条录音此前未完成收尾，已保留收到的文字。' : '',
        status: record.state === 'stopped' ? '录音已保存' : '未完成的录音', saved: true, saveStatus: savedLabel(record), error: '' });
      if (ACTIVE.indexOf(record.state) !== -1) { this.record.state = 'error'; this.setData({ captureState: 'error' }); }
      this.renderRecord(); this.loadAudio();
      this.scheduleSpeakerPolling();
      this.refreshDocument(true);
    } catch (error) { this.setData({ notice: error.message }); }
  },
  isCapturing: function () { return !!this.captureId; },
  goBack: async function () {
    if (this.isCapturing()) { this.setData({ notice: '请先停止接收或断开连接，再返回录音列表。' }); return; }
    if (this.data.busy) { this.setData({ notice: '正在处理当前录音，请稍候再返回。' }); return; }
    if (this.host) this.host.pause();
    this.stopSpeakerPolling(); this.stopDocumentPolling();
    this.closeSheets(); this.setData({ view: 'library', tab: 'recordings', searchOpen: false, running: false }); await this.loadLibrary();
  },
  setLanguage: function (event) { var language = valueOf(event); if (language !== 'zh' && language !== 'en') language = dataOf(event, 'language'); if (!this.isCapturing() && ['zh', 'en'].includes(language)) { this.setData({ language: language }); if (this.record && this.record.state === 'draft') this.record.language = language; } },
  setAsrMode: function (event) { var value = dataOf(event, 'asr'); if (ASR_MODES.includes(value) && !this.isCapturing()) { this.setData({ asrMode: value }); rememberAsr(this.storage, this.data); } },
  setLiveModel: function (event) { var value = dataOf(event, 'liveModel'); if (LIVE_MODELS.includes(value) && this.available(value)) { this.setData({ liveModel: value }); rememberAsr(this.storage, this.data); } },
  setFileModel: function (event) { var value = dataOf(event, 'fileModel'); if (FILE_MODELS.includes(value) && this.available(value)) { this.setData({ fileModel: value }); rememberAsr(this.storage, this.data); } },
  available: function (model) { var models = (this.data.capabilities || {}).models; return model === 'stepfun' || !!(models && models[model]); },
  // An unconfigured choice falls back to StepFun instead of failing the start.
  models: function () {
    var live = this.available(this.data.liveModel) ? this.data.liveModel : 'stepfun', file = this.available(this.data.fileModel) ? this.data.fileModel : 'stepfun';
    return { liveModel: this.data.asrMode === 'post' ? 'none' : live, fileModel: this.data.capabilities.speakers === false ? null : file };
  },
  setDisplayMode: function (event) { var mode = dataOf(event, 'mode'); if (MODES.includes(mode)) { this.setData({ displayMode: mode }); this.renderRecord(); } },
  autoConnect: function () {
    if (!this.runtime || !this.data.initialized || this.data.connected || this.data.busy || this.isCapturing()) return;
    var choice = preference(this.storage);
    if (choice === '0' || (choice !== '1' && !this.data.device)) return;
    return this.connectDevice({ automatic: true });
  },
  connectDevice: async function (event) {
    if (this.data.busy || this.isCapturing()) return;
    var automatic = !!(event && event.automatic);
    if (!this.runtime) { this.setData({ notice: '此宿主尚未接入录音豆运行时' }); return; }
    this.setData({ busy: 'connect', notice: '', runtimeStatus: '正在连接录音豆…' });
    try {
      if (!this.data.initialized) await this.initializeRuntime();
      if (!this.data.initialized) throw new Error(this.data.runtimeStatus);
      var deviceId = event && event.currentTarget ? event.currentTarget.dataset.device : undefined;
      var result = await this.runtime.connect(deviceId ? { deviceId: deviceId } : {});
      var patch = { connected: !!result.connected, devices: result.devices || [], sourceLabel: result.sourceLabel || this.data.sourceLabel,
        runtimeStatus: result.connected ? '录音豆已连接' : '请选择要连接的录音豆', status: result.connected ? '已连接，点击开始接收' : '请选择录音豆' };
      if (result.device) patch.device = result.device;
      this.setData(patch);
      if (result.connected) remember(this.storage, '1');
    } catch (error) {
      // An automatic attempt only reports quietly on the device tab.
      this.setData(automatic ? { connected: false, runtimeStatus: '没连上录音豆：' + error.message } : { connected: false, notice: error.message, runtimeStatus: error.message });
    }
    finally { this.setData({ busy: '' }); this.maybeAutoStart(); }
  },
  startCapture: async function () {
    if (this.data.busy || this.isCapturing()) return;
    if (!this.runtime || !this.data.connected) { this.setData({ notice: '请先连接录音豆' }); return; }
    if (!this.record || this.record.state !== 'draft') { this.setData({ notice: '请新建录音后开始接收，已有录音会保留。' }); return; }
    var models = this.models();
    if (models.liveModel === 'none' && !models.fileModel) { this.setData({ notice: '录后模式需要文件识别，暂不可用' }); return; }
    var id = this.captureId = this.record.id; this.record.state = 'waiting'; this.record.language = this.data.language;
    this.record.asrMode = this.data.asrMode; this.record.liveModel = models.liveModel; this.record.fileModel = models.fileModel;
    if (models.liveModel !== 'stepfun') this.record.language = 'zh';
    // The recorder is already recording when the key started this; show it as
    // such at once, but only with the file it named. Any start takes up a
    // waiting press: without its file the runtime finds the active one itself.
    var trigger = this.deviceTriggered;
    this.deviceTriggered = null; this.deviceRecordingPending = null;
    var triggered = !!(trigger && Number.isInteger(trigger.fileId) && trigger.fileId > 0 && Date.now() - trigger.at <= PRESS_WINDOW_MS);
    var fileId = triggered ? trigger.fileId : undefined;
    if (triggered) { this.record.state = 'recording'; this.record.startedAt = new Date().toISOString(); }
    this.setData({ busy: 'start', sessionOpen: true, captureState: triggered ? 'recording' : 'waiting', status: triggered ? '录音豆正在录音，正在接收…' : '正在准备接收…', notice: '' }); this.renderRecord(); await this.saveCurrent();
    try {
      // Only StepFun's realtime model needs the spoken language up front; the
      // others detect it, and translation follows each sentence.
      var spoken = models.liveModel === 'stepfun' ? this.data.language : 'zh';
      var result = await this.runtime.start({ recordingId: this.record.id, title: this.record.title, language: spoken, liveModel: models.liveModel, fileModel: models.fileModel, fileId: fileId });
      // A press noticed while this start was on its way is the same recording.
      this.deviceRecordingPending = null;
      // A failure reported meanwhile has already ended this capture.
      if (this.captureId === id) {
        if (result.startedAt && !triggered) this.record.startedAt = result.startedAt;
        if (this.data.captureState !== 'recording') this.setData({ captureState: 'waiting', status: '请按录音豆实体键开始录音' });
        await this.saveCurrent();
      }
    } catch (error) {
      this.deviceRecordingPending = null;
      if (this.record && this.record.id === id) { this.record.state = 'error'; this.setData({ captureState: 'error', sessionOpen: false, notice: error.message, status: '接收未能开始' }); }
      if (this.captureId === id) this.captureId = null;
      await this.saveCurrent();
    }
    finally { this.endBusy(); }
  },
  stopCapture: async function () {
    if (!this.captureId || this.data.busy === 'stop') return;
    this.setData({ busy: 'stop', captureState: 'finishing', status: '正在收尾并保存…', notice: '' });
    try { var result = await this.runtime.stop(); await this.applyResult(result); }
    catch (error) {
      // The runtime has already released this recording; what arrived stays,
      // and the page is free to go back or record again.
      if (this.record) this.record.state = 'error'; this.captureId = null;
      this.setData({ captureState: 'error', sessionOpen: false, status: '收尾未完成', notice: error.message }); await this.saveCurrent();
    }
    finally { this.endBusy(); }
  },
  // Before the physical key is pressed nothing is being recorded, so the live
  // sheet offers cancel instead of stop-and-save.
  cancelCapture: async function () {
    if (!this.captureId || !['draft', 'waiting'].includes(this.data.captureState) || this.data.busy) return;
    // Back to an empty draft, so the release is not recorded as an interrupted capture.
    this.captureId = null; if (this.record) this.record.state = 'draft';
    if (typeof this.runtime.abort === 'function') {
      try { await this.runtime.abort(); } catch (error) { this.setData({ notice: error.message }); }
      this.setData({ sessionOpen: false, captureState: 'draft', connected: this.linked() });
    } else await this.disconnectDevice();
    this.setData({ view: 'library', tab: 'device', notice: '已取消，这次没有录到内容。' });
    await this.loadLibrary();
  },
  linked: function () { var state = this.runtime && typeof this.runtime.device === 'function' ? this.runtime.device() : null; return !!(state && state.connected); },
  // The 断开 button: release now and stop reconnecting on open.
  releaseDevice: async function () {
    if (!this.runtime || this.data.busy || this.isCapturing()) return;
    remember(this.storage, '0');
    await this.disconnectDevice();
  },
  disconnectDevice: async function () {
    if (!this.runtime || this.data.busy) return;
    // A press seen on this link belongs to it; a new link watches afresh.
    this.deviceRecordingPending = null; this.deviceTriggered = null;
    try { await this.runtime.disconnect(); this.captureId = null; if (this.record && ACTIVE.indexOf(this.record.state) !== -1) { this.record.state = 'error'; await this.saveCurrent(); }
      this.setData({ connected: false, sessionOpen: false, captureState: this.record ? this.record.state : 'idle', runtimeStatus: '连接已释放', status: '连接已释放' }); }
    catch (error) { this.setData({ notice: error.message }); }
  },
  onRuntimeEvent: function (event) {
    if (!event) return;
    if (event.type === 'devices') { this.setData({ devices: event.devices || [] }); return; }
    if (event.type === 'device') {
      if (!event.device) return;
      if (!event.device.connected) { this.deviceRecordingPending = null; this.deviceTriggered = null; }
      this.setData({ device: event.device, connected: !!event.device.connected }); return;
    }
    if (event.type === 'recorder') { this.setData({ recorderUnreceived: !!event.unreceived }); return; }
    if (event.type === 'device_recording') { this.deviceRecordingPending = { fileId: event.fileId, at: Date.now() }; this.maybeAutoStart(); return; }
    // The phone's copy of saved audio may arrive after the next recording began.
    if (event.type === 'audio_cached') { this.cacheAudio(event); return; }
    if (event.recordingId && (!this.record || event.recordingId !== this.record.id)) return;
    if ((event.type === 'caption' || event.type === 'translation') && this.record) {
      try {
        this.record = recordings.applyCaption(this.record, event.event);
        if (event.type === 'caption' && this.captureId) { this.record.state = 'recording'; if (!this.record.startedAt) this.record.startedAt = new Date().toISOString(); this.setData({ captureState: 'recording', status: '正在录音' }); }
        this.renderRecord(); this.scheduleSave();
      } catch (error) { this.setData({ notice: error.message, status: '字幕处理异常，已保留此前内容' }); }
    } else if (event.type === 'audio') this.applyResult(event).catch(function (error) { this.setData({ notice: error.message }); }.bind(this));
    else if (event.type === 'error') {
      var failed = { status: '接收出现异常', notice: event.message || '连接异常，已保留此前文字' };
      if (this.record && this.captureId) {
        // The runtime has already released this recording. Keep what arrived,
        // and leave the page free to go back or start another one.
        this.record.state = 'error'; this.captureId = null; failed.sessionOpen = false; this.saveCurrent();
      }
      failed.captureState = this.record ? this.record.state : 'error';
      this.setData(failed);
    } else if (event.type === 'status') {
      var patch = { runtimeStatus: event.message || event.phase };
      if (event.phase === 'connected') patch.connected = true;
      if (event.phase === 'disconnected') patch.connected = false;
      if (event.phase === 'transcription_degraded' || event.phase === 'file_limit_reached') patch.notice = event.message;
      // A recording the key already started never goes back to waiting for it.
      var regress = event.phase === 'waiting' && this.data.captureState === 'recording';
      if (this.captureId && !regress && ['waiting', 'recording', 'finishing'].includes(event.phase)) {
        patch.captureState = event.phase; patch.status = event.message || event.phase;
        if (this.record) { this.record.state = event.phase; if (event.phase === 'recording' && !this.record.startedAt) this.record.startedAt = new Date().toISOString(); }
      }
      if (event.phase === 'stopped') { patch.connected = this.linked(); if (this.record && (this.record.audioBlob || this.record.audioUrl)) { patch.captureState = 'stopped'; patch.sessionOpen = false; this.captureId = null; } }
      this.setData(patch);
    }
  },
  applyResult: function (result) {
    if (!this.record || (result.recordingId && result.recordingId !== this.record.id)) return Promise.resolve();
    var key = this.record.id + ':' + (result.audio && result.audio.url || 'blob') + ':' + result.durationMs;
    if (key === this.resultKey && this.finalizing) return this.finalizing;
    this.resultKey = key; this.finalizing = this.finishResult(result);
    this.finalizing.catch(function () { if (this.resultKey === key) this.resultKey = null; }.bind(this));
    return this.finalizing;
  },
  finishResult: async function (result) {
    if (!this.record || (result.recordingId && result.recordingId !== this.record.id)) return;
    this.record = recordings.mergeSegments(this.record, result.segments);
    if (result.audio) {
      if (result.audio.blob) { this.record.audioBlob = result.audio.blob; this.record.hasAudioBlob = true; }
      if (result.audio.url) { if (this.host && !this.host.validAudioUrl(result.audio.url)) throw new Error('音频地址不是当前服务来源，未加载'); this.record.audioUrl = result.audio.url; }
      this.record.audioMimeType = result.audio.mimeType || (result.audio.blob && result.audio.blob.type) || 'audio/wav';
    }
    if (Number.isFinite(result.durationMs) && result.durationMs >= 0) this.record.durationMs = result.durationMs;
    if (Array.isArray(result.silenceRanges)) this.record.silenceRanges = result.silenceRanges;
    if (result.sourceType) this.record.sourceType = result.sourceType;
    if (this.record.audioUrl) this.record.serverSaved = true;
    if (!this.record.audioBlob && !this.record.audioUrl) throw new Error('服务未返回真实音频，未标记为完成');
    this.record.state = 'stopped'; this.record.endedAt = this.record.endedAt || new Date().toISOString(); this.captureId = null;
    this.setData({ captureState: 'stopped', tab: 'recordings', connected: this.linked(), sessionOpen: false, status: '录音已收尾，正在本地保存…', busy: 'save' });
    this.renderRecord(); this.loadAudio();
    // Only the phone's own copy is waited for: the service already holds this
    // recording, and its sync must not hold back a key press for the next one.
    var saved = await this.saveCurrent({ localOnly: true });
    this.setData({ busy: '', status: saved ? '录音与文字已保存' : '录音已收尾，本地保存失败' });
    this.refreshDocument(true);
    // The file transcript with speakers follows; poll until it is applied.
    if (this.record && this.record.fileModel) this.refreshSpeakers(true);
    this.maybeAutoStart();
  },
  // The phone's copy of audio the service saved, which arrives after the stop.
  cacheAudio: function (event) {
    var blob = event.blob, id = event.recordingId;
    if (!blob || typeof blob.size !== 'number' || !blob.size || typeof id !== 'string') return;
    var patch = { audioBlob: blob, hasAudioBlob: true };
    if (this.record && this.record.id === id) {
      if (this.record.audioBlob) return;
      Object.assign(this.record, patch);
      if (this.data.saved) this.setData({ saveStatus: savedLabel(this.record) });
    }
    this.cacheLocally(id, patch).catch(function () {});
  },
  // A few fields written into the stored copy in save order, so an older copy
  // read here can never land over a newer save.
  cacheLocally: function (id, patch) {
    var task = this.saveQueue.catch(function () {}).then(async function () {
      var cached = await this.store.get(id);
      if (cached) await this.store.save(Object.assign(cached, patch));
    }.bind(this));
    this.saveQueue = task.catch(function () {});
    return task;
  },
  // A record replaced from the service supersedes every save still queued for it.
  storeReplaced: function (record) {
    this.saveLatest[record.id] = ++this.saveVersion;
    var task = this.saveQueue.catch(function () {}).then(function () { return this.store.save(record); }.bind(this));
    this.saveQueue = task.catch(function () {});
    return task;
  },
  scheduleSave: function () { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = setTimeout(function () { this.saveTimer = null; this.saveCurrent(); }.bind(this), 350); },
  // Resolves once the phone's copy and then the service's are saved; with
  // localOnly, once the phone's copy is. Phone writes and service syncs run in
  // two queues, so a slow sync never holds back the next recording's saves.
  saveCurrent: function (options) {
    if (!this.record) return Promise.resolve(false);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.record.updatedAt = new Date().toISOString(); this.record.localPending = true;
    var version = ++this.saveVersion, snapshot = Object.assign({}, this.record, { segments: this.record.segments.map(function (row) { return Object.assign({}, row); }) }), id = snapshot.id;
    this.saveLatest[id] = version;
    var latest = function () { return this.saveLatest[id] === version; }.bind(this);
    var shown = function () { return !!(this.record && this.record.id === id && latest()); }.bind(this);
    this.setData({ saveStatus: '正在保存…', saved: false });
    var local = this.saveQueue.catch(function () {}).then(function () { return this.store.save(snapshot); }.bind(this)).then(function () {
      if (shown()) {
        var patch = { saved: true, saveStatus: savedLabel(snapshot) };
        if (this.saveNotice && this.saveNotice.id === id && this.data.notice === this.saveNotice.message) patch.notice = '';
        this.saveNotice = null; this.setData(patch);
      } return true;
    }.bind(this), function (error) { if (shown()) {
      this.saveNotice = { id: id, message: error.message };
      this.setData({ saved: false, saveStatus: '保存失败，请保留页面并导出备份', notice: error.message });
    } return false; }.bind(this));
    this.saveQueue = local;
    if (!this.runtime || typeof this.runtime.saveRecording !== 'function' || !['stopped', 'error'].includes(snapshot.state)) return local;
    var synced = (this.syncQueue || Promise.resolve()).catch(function () {}).then(function () { return local; }).then(async function (localSaved) {
      if (!localSaved) return false;
      try {
        var receipt = await this.runtime.saveRecording(snapshot); if (!receipt || receipt.saved !== true) throw new Error('私有服务未确认保存');
        // The newest save of this recording marks it synced, even after the page moved on to another one.
        if (latest()) {
          var mark = { serverSaved: true, localPending: false };
          if (receipt.contentVersion) mark.contentVersion = receipt.contentVersion;
          if (receipt.documentJob) mark.documentJob = receipt.documentJob;
          if (shown()) {
            Object.assign(this.record, mark); if (receipt.documentJob) this.renderRecord();
            if (this.record.documentJob) mark.documentJob = this.record.documentJob;
          }
          try { await this.cacheLocally(id, mark); if (shown()) this.setData({ saveStatus: savedLabel(this.record), syncFailed: false }); }
          catch (cacheError) { if (shown()) { this.saveNotice = { id: id, message: cacheError.message }; this.setData({ saveStatus: '私有服务已保存 · 本机同步标记更新失败', syncFailed: false, notice: cacheError.message }); } }
        }
      }
      // Reported once, inline with a retry; the recording is already safe locally.
      catch (error) { if (shown()) this.setData({ saveStatus: '本机已保存 · 服务同步失败', syncFailed: true }); }
      return true;
    }.bind(this));
    this.syncQueue = synced;
    return options && options.localOnly ? local : synced;
  },
  retrySync: function () { if (this.record && !this.isCapturing() && !this.data.busy) return this.saveCurrent(); },
  renderRecord: function () {
    if (!this.record) return;
    var record = this.record, matches = 0, query = this.data.searchOpen ? String(this.data.searchQuery || '').trim() : '', mode = this.data.displayMode, language = record.language || 'zh', missing = 0, speakers = {};
    function marked(text) {
      var result = parts(text, query);
      result.forEach(function (part) { if (part.match) matches++; });
      return result;
    }
    var rows = record.segments.map(function (row) {
      // Each sentence is shown in the chosen language(s): the source where it is
      // that language, its translation where it is not. A missing translation
      // falls back to the source, marked so the page can say it is not translated.
      var sourceLanguage = row.sourceLanguage === 'zh' || row.sourceLanguage === 'en' ? row.sourceLanguage : language;
      var translated = row.translation && row.translationLanguage && row.translationLanguage !== sourceLanguage ? row.translation : '';
      var showSource = mode === 'both' || mode === sourceLanguage;
      if (row.source && row.sourceFinal && !translated && mode !== sourceLanguage) missing++;
      if (row.speaker) speakers[row.speaker] = true;
      return Object.assign({}, row, { time: row.startMs === null ? '--:--' : recordings.timeLabel(row.startMs), final: row.sourceFinal,
        primaryParts: marked(showSource ? row.source : (translated || row.source)), untranslated: !showSource && !translated,
        secondaryParts: mode === 'both' && translated ? marked(translated) : [], pendingTranslation: mode === 'both' && !translated && row.sourceFinal && !!row.source });
    });
    // A search lists only the sentences that contain it; each opens in context.
    if (query) rows = rows.filter(function (row) { return row.primaryParts.concat(row.secondaryParts).some(function (part) { return part.match; }); });
    var speakerJob = record.speakerJob || { status: 'idle' }, speakerMessages = {
      idle: '多人录音可在录完后按声音区分发言人。', submitting: '正在提交识别，原稿保留。',
      pending: '识别已排队，可以离开页面，任务会继续。', running: '正在识别发言人，可以离开页面，任务会继续。',
      ready: '已识别 ' + (speakerJob.speakerCount || 0) + ' 位发言人、' + (speakerJob.segmentCount || 0) + ' 段文字。应用后更新文字与时间，当前原稿保留备份。',
      applied: '已应用识别结果，原稿已保留备份。'
    };
    var job = record.speakerJob || {}, automatic = !!record.fileModel && !record.speakerDiarization;
    var transcribing = automatic && (ACTIVE_JOBS.includes(job.status) || job.status === 'ready' || (job.status || 'idle') === 'idle' && record.state === 'stopped');
    // No job yet means different things: the document waits for the full
    // transcript, a broken recording never gets one, an old one can be asked for.
    var documentJob = record.documentJob || { status: 'idle' }, documentMessages = {
      idle: transcribing ? '全文识别完成后会自动生成飞书文档。' : record.state === 'error' ? (record.fileAsrAvailable ? '录音没有正常结束；可在“更多”里识别全文，完成后会生成飞书文档。' : '录音没有正常结束，没有自动生成飞书文档。') :
        record.state === 'stopped' ? '还没有飞书文档，可以点“生成”。' : '录完会自动生成飞书文档。',
      no_text: '这次没有识别出文字，未生成飞书文档。',
      queued: '文档已排队，可以离开页面。', summarizing: '正在整理纪要，可以离开页面。',
      creating: '正在创建飞书文档…', securing: '正在准备私人文档…', writing: '正在写入飞书文档…',
      verifying: '正在核对文档内容…', retrying: '连接暂时中断，云端正在重试。',
      ready: '纪要、章节和完整文字记录'
    };
    this.setData({ recordAsrMode: record.asrMode || 'live', transcribing: transcribing,
      fileJobError: automatic && ['failed', 'uncertain'].includes(job.status) ? job.error || '全文识别没有完成' : '' });
    this.setData({ recordingId: record.id, title: record.title, summaryTitle: summaryTitle(record), sourceLabel: record.sourceLabel || this.data.sourceLabel, originLabel: originLabel(record), dateLabel: stamp(record.createdAt), createdAt: stamp(record.createdAt), language: language,
      documentStatus: documentJob.status, documentMessage: documentJob.stale ? '文字已变动；文档保留生成时的版本。' : documentJob.error || documentMessages[documentJob.status] || '', documentUrl: documentJob.status === 'ready' ? documentJob.url || '' : '',
      speakerJobStatus: speakerJob.status, speakerJobMessage: record.localSourceConflict ? '服务端已有新原稿，本机未同步的内容仍保留；请先导出当前内容备份。' : (speakerJob.error || speakerMessages[speakerJob.status] || ''), speakerPreview: speakerJob.preview || [],
      rows: rows, speakerCount: Object.keys(speakers).length, translationMissing: missing,
      searchCount: matches, searchResults: !!query,
      duration: recordings.timeLabel(record.durationMs), durationMs: record.durationMs || 0, hasAudio: !!(record.audioBlob || record.audioUrl), translationStatus: record.translationStatus || 'idle' });
  },
  loadAudio: function () {
    if (!this.host || !this.record || (!this.record.audioBlob && !this.record.audioUrl)) return;
    var blob = this.audioFallbackFor === this.record.id ? null : this.record.audioBlob;
    var key = this.record.id + ':' + (blob ? blob.size : this.record.audioUrl);
    if (this.audioKey === key) return;
    this.host.setAudio({ blob: blob, url: this.record.audioUrl }); this.host.setPlaybackRate(this.data.speed); this.audioKey = key;
  },
  togglePlayback: async function () {
    if (!this.host || !this.data.hasAudio) { this.setData({ notice: this.data.hasAudio ? '此宿主尚未接入音频播放器' : '收尾保存真实音频后即可播放' }); return; }
    // The element's own state decides: some webviews never deliver 'playing',
    // which left the button showing play and unable to pause.
    var playing = typeof this.host.paused === 'function' ? !this.host.paused() : this.data.running;
    if (playing) { this.host.pause(); this.setData({ running: false }); return; }
    try {
      await this.host.play();
      // play() resolving means playback began; trust the element, not a later event.
      if (typeof this.host.paused === 'function') this.setData({ running: !this.host.paused() });
    } catch (error) { this.setData({ running: false, notice: '音频无法播放：' + error.message }); }
  },
  onAudioTime: function (event) {
    var position = Number(event.currentTime) || 0, duration = Number.isFinite(event.duration) && event.duration > 0 ? event.duration : (this.record ? this.record.durationMs / 1000 : 0);
    var patch = { elapsed: recordings.timeLabel(position * 1000), duration: recordings.timeLabel(duration * 1000), progress: duration ? Math.max(0, Math.min(100, position / duration * 100)) : 0 };
    if (typeof event.paused === 'boolean') patch.running = !event.paused && !event.ended;
    this.setData(patch);
  },
  onAudioState: function (state) {
    this.setData({ running: state === 'playing' });
    if (state === 'playing' && this.audioFallbackNotice && this.data.notice === this.audioFallbackNotice) {
      this.setData({ notice: '' }); this.audioFallbackNotice = null;
    }
    if (state !== 'error') return;
    if (this.record && this.record.audioBlob && this.record.audioUrl && this.host && this.host.validAudioUrl(this.record.audioUrl) && this.audioFallbackFor !== this.record.id) {
      // Preserve the local copy; a persisted Blob may no longer be playable in this webview.
      this.audioFallbackFor = this.record.id;
      this.audioFallbackNotice = '本机音频暂不可用，已切换私有服务音频，请点击播放。';
      this.setData({ notice: this.audioFallbackNotice }); this.loadAudio();
      return;
    }
    this.setData({ notice: '音频播放失败；原始录音仍可尝试导出。' });
  },
  seek: function (event) { var value = Number(valueOf(event)); if (Number.isFinite(value) && this.host && this.data.hasAudio) this.host.seekFraction(Math.max(0, Math.min(100, value)) / 100); },
  cycleSpeed: function () { var speed = SPEEDS[(SPEEDS.indexOf(this.data.speed) + 1) % SPEEDS.length]; this.setData({ speed: speed }); if (this.host) this.host.setPlaybackRate(speed); },
  stopSpeakerPolling: function () { if (this.speakerTimer) clearTimeout(this.speakerTimer); this.speakerTimer = null; this.speakerPollVersion = (this.speakerPollVersion || 0) + 1; },
  stopDocumentPolling: function () { if (this.documentTimer) clearTimeout(this.documentTimer); this.documentTimer = null; this.documentPollVersion = (this.documentPollVersion || 0) + 1; },
  refreshDocument: async function (automatic) {
    if (!this.record || !this.runtime || !this.data.capabilities.documents || typeof this.runtime.getDocument !== 'function' || this.isCapturing()) return;
    var id = this.record.id, version = this.documentPollVersion || 0;
    try {
      var result = await this.runtime.getDocument({ recordingId: id });
      if (!this.record || this.record.id !== id || version !== (this.documentPollVersion || 0) || this.data.view !== 'detail') return;
      var changed = JSON.stringify(this.record.documentJob || null) !== JSON.stringify(result.job);
      this.record.documentJob = result.job; this.renderRecord();
      // Keep the cached copy current so the list shows the summary title too;
      // only the job changes, so this never triggers another server sync.
      if (changed) await this.cacheLocally(id, { documentJob: result.job });
      if (this.documentTimer) clearTimeout(this.documentTimer);
      if (['queued', 'summarizing', 'creating', 'securing', 'writing', 'verifying', 'retrying'].includes(result.job.status)) {
        this.documentTimer = setTimeout(function () { this.documentTimer = null; this.refreshDocument(true); }.bind(this), 3000);
      }
    } catch (error) { if (!automatic) this.setData({ notice: error.message }); }
  },
  requestDocument: async function () {
    if (!this.record || this.isCapturing() || this.data.busy || !this.data.capabilities.documents) return;
    var id = this.record.id;
    this.setData({ busy: 'document', notice: '' });
    try {
      await this.saveCurrent();
      if (this.record.localPending || !this.record.serverSaved) throw new Error('请先把当前文字保存到私有服务');
      var result = await this.runtime.createDocument({ recordingId: id });
      if (!this.record || this.record.id !== id) return;
      this.record.documentJob = result.job; this.renderRecord(); this.refreshDocument(true);
    } catch (error) { this.setData({ notice: error.message }); }
    finally { this.endBusy(); }
  },
  scheduleSpeakerPolling: function () {
    this.stopSpeakerPolling();
    var status = (this.record && this.record.speakerJob || {}).status;
    if (!this.record || this.data.view !== 'detail' || !(ACTIVE_JOBS.includes(status) || (status === 'ready' && this.record.fileModel))) return;
    this.speakerTimer = setTimeout(function () { this.speakerTimer = null; this.refreshSpeakers(true); }.bind(this), 3000);
  },
  refreshSpeakers: async function (automatic) {
    if (!this.record || !this.runtime || typeof this.runtime.getSpeakers !== 'function') return;
    var id = this.record.id, version = this.speakerPollVersion || 0;
    try {
      var result = await this.runtime.getSpeakers({ recordingId: id });
      if (!this.record || this.record.id !== id || version !== (this.speakerPollVersion || 0)) return;
      this.record.speakerJob = result.job;
      if (result.job.status === 'applied' && !this.record.speakerDiarization) await this.reloadFromServer(id);
      if (!this.record || this.record.id !== id) return;
      this.renderRecord(); this.scheduleSpeakerPolling();
    } catch (error) { if (!automatic) this.setData({ notice: error.message }); }
  },
  // An automatically applied file transcript replaces the realtime text here;
  // the local audio stays, and nothing local is pending once it is fetched.
  reloadFromServer: async function (id) {
    if (typeof this.runtime.getRecording !== 'function') return;
    var fresh = await this.runtime.getRecording({ recordingId: id });
    // Only a manual edit (older app versions) outranks the server's file transcript.
    if (!fresh || !this.record || this.record.id !== id || this.record.contentEdited) return;
    this.record = Object.assign({}, fresh, { audioBlob: this.record.audioBlob, hasAudioBlob: !!this.record.audioBlob, serverSaved: true, localPending: false,
      asrMode: this.record.asrMode, liveModel: this.record.liveModel, fileModel: this.record.fileModel });
    await this.storeReplaced(this.record);
    this.refreshDocument(true);
  },
  requestSpeakers: async function () {
    if (!this.record || this.isCapturing() || this.data.busy) return;
    if (!this.runtime || !this.data.capabilities.speakers) { this.setData({ notice: '发言人识别暂不可用' }); return; }
    // A recording that broke off can still be recognised once the service has its complete audio.
    if (this.record.state !== 'stopped' && !this.record.fileAsrAvailable) { this.setData({ notice: '请先完成录音并保存音频' }); return; }
    this.setData({ busy: 'speakers', notice: '' });
    try {
      await this.saveCurrent();
      if (this.record.localPending || !this.record.serverSaved) throw new Error('请先把当前内容同步到私有服务');
      var result = await this.runtime.identifySpeakers({ recordingId: this.record.id, provider: this.models().fileModel || 'stepfun' });
      this.record.speakerJob = result.job; this.renderRecord(); this.scheduleSpeakerPolling();
    } catch (error) { this.setData({ notice: error.message }); }
    finally { this.endBusy(); }
  },
  applySpeakerResult: async function () {
    if (!this.record || this.isCapturing() || this.data.busy || (this.record.speakerJob || {}).status !== 'ready') return;
    this.stopSpeakerPolling(); this.setData({ busy: 'speakers', notice: '' });
    try {
      await this.saveCurrent();
      if (this.record.localPending || !this.record.serverSaved) throw new Error('请先保存并同步当前内容');
      var result = await this.runtime.applySpeakers({ recordingId: this.record.id, expectedContentVersion: this.record.contentVersion });
      this.record = Object.assign({}, result.recording, { audioBlob: this.record.audioBlob, serverSaved: true, localPending: false });
      this.renderRecord(); await this.storeReplaced(this.record);
      this.setData({ notice: '发言人识别结果已应用，原稿备份已保留', optionsOpen: false });
    } catch (error) { this.setData({ notice: error.message }); }
    finally { this.endBusy(); }
  },
  seekSegment: function (event) {
    var id = dataOf(event, 'id'), row = this.record && this.record.segments.find(function (item) { return item.id === id; });
    if (!row) return;
    if (!this.host || !this.data.hasAudio) { this.setData({ notice: '收尾保存真实音频后即可定位原音' }); return; }
    if (!Number.isFinite(row.startMs) || row.startMs < 0) { this.setData({ notice: '这一段尚未提供时间，暂不能定位原音' }); return; }
    this.host.seekSeconds(row.startMs / 1000);
  },
  toggleSearch: function () { this.setData({ searchOpen: true, searchQuery: '', optionsOpen: false }); this.renderRecord(); },
  updateSearch: function (event) { this.setData({ searchQuery: String(valueOf(event) || '').slice(0, 80) }); this.renderRecord(); },
  clearQuery: function () { this.updateSearch(''); },
  clearSearch: function () { this.setData({ searchOpen: false, searchQuery: '' }); this.renderRecord(); },
  // A result opens in the full transcript, so the sentence is read in context;
  // it is scrolled to once and briefly highlighted.
  openResult: function (event) {
    var id = String(dataOf(event, 'result') || '');
    if (!this.record || !this.record.segments.some(function (row) { return String(row.id) === id; })) return;
    clearTimeout(this.flashTimer);
    this.setData({ searchOpen: false, searchQuery: '', scrollTarget: 'utt-' + id, flashRow: id }); this.renderRecord();
    this.flashTimer = setTimeout(function () { this.setData({ scrollTarget: '', flashRow: '' }); }.bind(this), 1600);
  },
  toggleOptions: function () { this.setData({ optionsOpen: !this.data.optionsOpen, notice: '' }); },
  closeSheets: function () { this.setData({ optionsOpen: false, devices: [], deleteOpen: false }); },
  dismissNotice: function () { this.setData({ notice: '' }); },
  requestTranslation: async function () {
    if (!this.record || !this.record.segments.length || this.isCapturing()) { this.setData({ notice: '请先停止接收并保留文字，再请求翻译' }); return; }
    if (!this.runtime || !this.data.capabilities.translation) { this.setData({ notice: '翻译服务尚未可用' }); return; }
    if (this.data.busy) return;
    var id = this.record.id, target = (this.record.language || 'zh') === 'zh' ? 'en' : 'zh';
    this.record.translationStatus = 'loading'; this.setData({ busy: 'translation', notice: '' }); this.renderRecord();
    try {
      var result = await this.runtime.translate({ recordingId: id, segments: this.record.segments, targetLanguage: target });
      if (!this.record || this.record.id !== id) return;
      if (!Array.isArray(result.translations) || !result.translations.length) throw new Error('服务没有返回译文');
      if (this.record.segments.some(function (row) { return row.source && !result.translations.some(function (item) { return item.id === row.id && typeof item.text === 'string' && item.text.trim(); }); })) throw new Error('服务未返回全部段落的译文，保留已有翻译');
      this.record.segments = this.record.segments.map(function (row) { var translation = result.translations.find(function (item) { return item.id === row.id; });
        return translation && typeof translation.text === 'string' ? Object.assign({}, row, { translation: translation.text, translationLanguage: translation.language || target, translationFinal: true, translationRevision: row.translationRevision + 1 }) : row; });
      this.record.translationStatus = 'ready'; this.record.translationError = ''; await this.saveCurrent();
    } catch (error) { if (this.record && this.record.id === id) { this.record.translationStatus = 'error'; this.record.translationError = error.message; await this.saveCurrent(); } this.setData({ notice: error.message }); }
    finally { this.setData({ busy: '' }); this.renderRecord(); this.maybeAutoStart(); }
  },
  exportFile: async function (event) {
    if (!this.record || !this.host || !this.host.download) { this.setData({ notice: '此宿主尚未接入文件导出' }); return; }
    if (this.exporting) return;
    this.exporting = true;
    var record = this.record, format = dataOf(event, 'format'), blob, extension = format;
    try {
      if (format === 'txt') blob = this.host.textBlob(recordings.toText(this.record), 'text/plain;charset=utf-8');
      else if (format === 'audio') { blob = record.audioBlob || await this.host.fetchAudio(record.audioUrl); if (!blob) throw new Error('没有可导出的音频'); if (this.record !== record) return; record.audioBlob = blob; extension = /ogg/i.test(blob.type) ? 'ogg' : /mp4/i.test(blob.type) ? 'm4a' : /webm/i.test(blob.type) ? 'webm' : 'wav'; }
      else return;
      var result = await this.host.download(blob, recordings.safeFilename(summaryTitle(record) || record.title) + '.' + extension);
      if (this.record !== record) return;
      if (result && result.cancelled) this.setData({ notice: '已取消导出。' });
      else this.setData({ notice: result && result.method === 'system' ? '系统文件操作已完成。' : '文件已生成，请在浏览器下载或存储菜单中保存。', optionsOpen: false });
    } catch (error) { if (this.record === record) this.setData({ notice: error.message }); }
    finally { this.exporting = false; }
  },
  onHide: function () { if (this.host) this.host.pause(); if (this.record) this.saveCurrent(); },
  onUnload: function () { this.stopSpeakerPolling(); this.stopDocumentPolling(); if (this.saveTimer) clearTimeout(this.saveTimer); if (this.record) this.saveCurrent(); if (this.unsubscribe) this.unsubscribe(); if (this.host) this.host.dispose(); if ((this.captureId || this.data.connected) && this.runtime) this.runtime.disconnect().catch(function () {}); }
});
