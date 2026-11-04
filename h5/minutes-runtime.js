(function (root) {
  'use strict';
  var SDK_URL = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.16.js';
  // Audio held while the private stream opens (20 s; the open itself times out at 15 s).
  var EARLY_FRAMES = 1000;
  // The service acknowledges each frame once it is stored. An acknowledgement
  // older than this ends the stream; the unacknowledged count only bounds
  // memory, so it sits above all the timeouts allow (the held audio plus a
  // full first-acknowledgement wait at 50 frames a second).
  var ACK_TIMEOUT_MS = 15000, FIRST_ACK_TIMEOUT_MS = 30000;
  var MAX_UNACKED = EARLY_FRAMES + FIRST_ACK_TIMEOUT_MS / 20 + 100;
  // Final text after stop: the service may finish its providers and
  // translations for about 48 s, and it finishes even if the phone goes away.
  var COMPLETE_TIMEOUT_MS = 90000;
  // One delete request names at most this many recordings.
  var MAX_DELETE = 100;
  var basePath = new URL('.', location.href).pathname.replace(/\/$/, '');
  function apiPath(path) { return basePath + path; }
  var listeners = new Set();
  var connection = null, connected = false, initialized = false, sdkPromise = null;
  var current = null;
  var sourceLabel = 'soundcore Work 录音豆';
  var apiStatus = null;
  // Last device reading, kept per browser so the device tab can show it with
  // its time without connecting. Only status values; never a device identifier.
  var DEVICE_KEY = 'minutes.device.v1';
  var DEVICE_FIELDS = ['firmware', 'micBattery', 'micCharging', 'caseBattery', 'caseCharging', 'caseFirmware',
    'wifiFirmware', 'storage', 'recording', 'boundAdvertised', 'boundReadAt', 'readAt'];
  var device = (function () {
    try { var value = JSON.parse(root.localStorage.getItem(DEVICE_KEY) || 'null'); return value && typeof value === 'object' ? pick(value) : null; }
    catch (_) { return null; }
  }());
  function pick(value) {
    var result = {};
    DEVICE_FIELDS.forEach(function (key) { if (value[key] !== undefined && value[key] !== null) result[key] = value[key]; });
    return result;
  }
  function deviceSnapshot() { return Object.assign({ connected: connected }, device || {}); }
  function deviceChanged() { emit({ type: 'device', device: deviceSnapshot() }); }
  function rememberDevice(patch) {
    device = Object.assign({}, device || {}, pick(patch));
    try { root.localStorage.setItem(DEVICE_KEY, JSON.stringify(device)); } catch (_) {}
    deviceChanged();
  }
  function diagnostic(event, operation) {
    var allowed = ['type', 'code', 'command', 'authenticationCode', 'diagnosticRawHex',
      'notificationBytes', 'reassembled', 'checksumVerified', 'phase', 'deviceInfoBytes',
      'supportAuthRaw', 'hasAuthUidRaw', 'supportAuth', 'hasAuthUid', 'api', 'platformCode',
      'eventCount', 'advertisedCount', 'cachedCount', 'connectedCount', 'matchedCount'];
    var value = { at: new Date().toISOString(), recordingId: operation ? operation.recordingId : current && current.recordingId };
    allowed.forEach(function (key) { if (event && event[key] !== undefined) value[key] = event[key]; });
    if (event && typeof event.message === 'string' && event.message) value.message = event.message.slice(0, 160);
    fetch(apiPath('/api/diagnostics'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value) }).catch(function () {});
  }

  function emit(event) {
    listeners.forEach(function (listener) { try { listener(event); } catch (_) {} });
  }
  function owns(operation) { return current === operation && !operation.cancelled; }
  function requireOwner(operation) { if (!owns(operation)) throw new Error('接收已取消'); }
  function status(phase, message, operation) {
    if (operation && !owns(operation)) return;
    emit({ type: 'status', phase: phase, message: message, recordingId: operation ? operation.recordingId : current && current.recordingId });
  }
  function fail(error, operation) {
    if (operation && !owns(operation)) return;
    diagnostic(error || { code: 'UNKNOWN' }, operation);
    var message = error && error.message ? error.message : '实时连接失败';
    if (error && error.code === 'DEVICE_AUTH_REJECTED') message = '录音豆要求绑定鉴权，当前会话未获准读取；请保留现有绑定状态';
    emit({ type: 'error', recordingId: operation ? operation.recordingId : current && current.recordingId, message: message });
  }
  // A failed request says what happened and what to do next; the status code
  // stays on the error for diagnostics instead of in the sentence.
  function requestFailure(status) {
    if (status === 401) return '私有测试登录已过期，请重新进入';
    if (status === 404) return '私有服务上找不到这项内容，请返回列表刷新';
    if (status === 413) return '内容太大，私有服务没有接收；可以先在“更多”里导出到手机保存';
    if (status === 429) return '请求太频繁，请稍等一会儿再试';
    if (status >= 500) return '私有服务暂时不可用，请稍后重试；手机上的内容不受影响';
    return '私有服务没有接受这次请求，请刷新页面后重试';
  }
  async function json(path, body) {
    var response;
    try {
      response = await fetch(apiPath(path), {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (_) { throw new Error('连不上私有服务，请检查网络后重试'); }
    var value;
    try { value = await response.json(); } catch (_) { value = {}; }
    if (!response.ok) {
      // Only the service's own Chinese sentences pass through; anything else
      // (an exception text, a proxy page) gets the plain fallback.
      var own = response.status !== 401 && typeof value.error === 'string' && /[\u4e00-\u9fff]/.test(value.error) && value.error;
      var error = new Error(own || requestFailure(response.status));
      error.status = response.status; throw error;
    }
    return value;
  }
  var signingIn = false;
  function signInAgain() {
    if (signingIn || current || !root.location || typeof root.location.reload !== 'function') return;
    signingIn = true;
    emit({ type: 'status', phase: 'signing_in', message: '登录已过期，正在通过飞书重新登录…' });
    setTimeout(function () { root.location.reload(); }, 600);
  }
  function deferred() {
    var result = {};
    result.promise = new Promise(function (resolve, reject) { result.resolve = resolve; result.reject = reject; });
    // Errors still reject explicit awaiters; attach a handler while waiting for
    // the user to press stop so an early disconnect is not an unhandled rejection.
    result.promise.catch(function () {});
    return result;
  }
  async function loadSdk() {
    if (root.h5sdk && typeof root.h5sdk.config === 'function') return;
    await new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timer = setTimeout(function () { reject(new Error('飞书工具包加载超时')); }, 15000);
      script.src = SDK_URL;
      script.onload = function () { clearTimeout(timer); resolve(); };
      script.onerror = function () { clearTimeout(timer); reject(new Error('飞书工具包加载失败')); };
      document.head.appendChild(script);
    });
  }
  async function authenticateSdk() {
    if (!root.isSecureContext || !root.crypto || !root.crypto.subtle) {
      throw new Error('蓝牙解密需要可信 HTTPS 页面；当前地址无法进行手机实测');
    }
    if (!/Lark|Feishu/i.test(navigator.userAgent)) {
      throw new Error('请在 iPhone 飞书内打开此网页后连接录音豆');
    }
    if (!apiStatus || !apiStatus.jsapiConfigured) throw new Error('飞书网页鉴权尚未配置');
    await loadSdk();
    var configuration = await json('/api/jsapi-config', { url: location.href.split('#')[0] });
    await new Promise(function (resolve, reject) {
      var ready = false, authenticated = false;
      var timer = setTimeout(function () { reject(new Error('飞书网页鉴权超时')); }, 20000);
      function done() { if (ready && authenticated) { clearTimeout(timer); resolve(); } }
      root.h5sdk.error(function () { clearTimeout(timer); reject(new Error('飞书网页鉴权失败，请检查可信域名和应用测试范围')); });
      root.h5sdk.ready(function () { ready = true; done(); });
      root.h5sdk.config(Object.assign({}, configuration, {
        jsApiList: ['openBluetoothAdapter', 'startBluetoothDevicesDiscovery', 'stopBluetoothDevicesDiscovery',
          'getBluetoothDevices', 'getConnectedBluetoothDevices', 'onBluetoothDeviceFound', 'offBluetoothDeviceFound', 'connectBLEDevice',
          'getBLEDeviceServices', 'getBLEDeviceCharacteristics', 'notifyBLECharacteristicValueChange',
          'writeBLECharacteristicValue', 'onBLECharacteristicValueChange', 'offBLECharacteristicValueChange',
          'onBLEConnectionStateChange', 'offBLEConnectionStateChange', 'disconnectBLEDevice', 'vibrateLong'],
        onSuccess: function () { authenticated = true; done(); },
        onFail: function () { clearTimeout(timer); reject(new Error('飞书拒绝了网页鉴权')); }
      }));
    });
  }
  async function sdk() {
    if (!sdkPromise) sdkPromise = authenticateSdk().catch(function (error) { sdkPromise = null; throw error; });
    return sdkPromise;
  }
  function clearSocket(operation) {
    if (!operation) return;
    clearTimeout(operation.openTimer);
    clearInterval(operation.ackTimer);
    operation.pendingAcks.clear();
    var ws = operation.socket;
    operation.socket = null;
    if (ws && ws.readyState < 2) ws.close();
  }
  function cancel(operation, error) {
    if (!operation) return;
    operation.cancelled = true;
    operation.ready.reject(error);
    operation.completion.reject(error);
    clearSocket(operation);
  }
  function halt(operation, error) {
    if (!owns(operation)) return;
    fail(error, operation);
    var owner = operation.connection;
    cancel(operation, error);
    current = null;
    if (connection === owner) { connection = null; connected = false; }
    owner.cancelled = true;
    owner.device.disconnect().catch(function () {});
    deviceChanged();
  }
  function uint32(value) { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff; }
  // One buzz when the recorder is found still recording after a phone stop,
  // so the reminder is felt, not only seen. Not every client can vibrate.
  var unreceived = false;
  function buzz() {
    try { if (root.tt && typeof root.tt.vibrateLong === 'function') root.tt.vibrateLong({ success: function () {}, fail: function () {} }); } catch (_) {}
  }
  function idleLink() {
    if (current) throw new Error('正在接收录音，结束后再管理录音豆里的文件');
    if (!connected || !connection || !connection.device) throw new Error('请先连接录音豆');
    return connection;
  }
  function sourceDeviceId(operation) {
    var value = operation.connection.device.deviceId;
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('录音豆来源身份缺少有效设备标识');
    return value;
  }
  function bindVerifiedSource(operation, event) {
    requireOwner(operation);
    if (event.fileKeyVerified !== true || !uint32(event.fileId) || event.fileId === 0 || event.sourceType !== 'live_device_recording') {
      throw new Error('录音豆音频头未通过来源身份核对');
    }
    var deviceId = sourceDeviceId(operation), previous = operation.verifiedSource;
    if (previous && (previous.fileId !== event.fileId || previous.jsapiDeviceId !== deviceId || previous.sourceType !== event.sourceType)) {
      throw new Error('录音来源身份已变化，已停止接收以避免混入另一段录音');
    }
    if (!previous) operation.verifiedSource = { fileId: event.fileId, jsapiDeviceId: deviceId, sourceType: event.sourceType };
  }
  function sendFrame(operation, frame) {
    requireOwner(operation);
    var ws = operation.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('语音连接未就绪，未丢弃后继续发送');
    if (!frame || !(frame.opus instanceof Uint8Array) || frame.opus.length !== 160 || !uint32(frame.sequence)) {
      throw new Error('录音豆音频帧格式不正确');
    }
    var identity = operation.verifiedSource;
    if (!identity) throw new Error('尚未核对录音豆音频头，不能发送来源身份或音频');
    if (frame.fileId !== identity.fileId || frame.sourceType !== identity.sourceType || sourceDeviceId(operation) !== identity.jsapiDeviceId) {
      throw new Error('音频帧与已核对的来源身份不一致，已停止接收');
    }
    if (!Number.isSafeInteger(frame.receivedAtMs) || frame.receivedAtMs <= 0) throw new Error('音频帧接收时间无效');
    if (ws.bufferedAmount > 512 * 1024 || operation.pendingAcks.size >= MAX_UNACKED) throw new Error('网络发送积压，已停止接收以避免无声丢帧');
    if (!operation.sourceIdentitySent) {
      // This identifies the client-verified transfer, not a native Minutes token
      // or an authenticated hardware identity. Keep it out of editable metadata.
      ws.send(JSON.stringify({ type: 'source_identity', recordingId: operation.recordingId, identity: {
        schemaVersion: 1, protocol: 'soundcore-d3200', fileId: identity.fileId, jsapiDeviceId: identity.jsapiDeviceId,
        sourceType: identity.sourceType, firstSequence: frame.sequence, firstReceivedAtMs: frame.receivedAtMs, headerIdMatched: true
      } }));
      operation.sourceIdentitySent = true;
    }
    var buffer = new ArrayBuffer(164);
    new DataView(buffer).setUint32(0, frame.sequence, true);
    new Uint8Array(buffer, 4).set(frame.opus);
    operation.pendingAcks.set(frame.sequence, Date.now());
    ws.send(buffer);
  }
  // A phone copy of audio the service has already saved. A failure leaves the
  // recording playing from the service and is only reported as a diagnostic.
  function cacheAudio(recordingId, url) {
    fetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) { var failure = new Error('音频下载失败'); failure.code = 'HTTP_' + response.status; throw failure; }
      return response.blob();
    }).then(function (blob) { emit({ type: 'audio_cached', recordingId: recordingId, url: url, blob: blob }); },
      function (error) { diagnostic({ type: 'audio_cache_failed', code: error && error.code || 'NETWORK' }, { recordingId: recordingId }); });
  }
  // Audio read before the private stream was ready, sent in order once it is.
  function flushEarly(operation) {
    var held = operation.early;
    operation.early = null;
    if (!held) return true;
    try { held.forEach(function (frame) { sendFrame(operation, frame); }); return true; }
    catch (error) { halt(operation, error); return false; }
  }
  async function openSocket(operation, language) {
    var url = new URL(apiPath('/api/stream'), location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(url.href);
    operation.socket = ws;
    operation.openTimer = setTimeout(function () {
      halt(operation, new Error('私有语音服务连接超时'));
    }, 15000);
    ws.onopen = function () {
      if (!owns(operation) || operation.socket !== ws) { ws.close(); return; }
      var start = { type: 'start', recordingId: operation.recordingId, title: operation.title, language: language, sourceType: 'live_device', liveModel: operation.liveModel };
      if (operation.fileModel) start.fileModel = operation.fileModel;
      ws.send(JSON.stringify(start));
    };
    ws.onmessage = function (message) {
      if (!owns(operation) || operation.socket !== ws) return;
      var event;
      try { event = JSON.parse(message.data); } catch (_) { halt(operation, new Error('服务返回无法读取的消息')); return; }
      if (event.recordingId && event.recordingId !== operation.recordingId) {
        halt(operation, new Error('服务返回了不属于当前录音的结果')); return;
      }
      if (event.type === 'ready') {
        clearTimeout(operation.openTimer); operation.readySeen = true;
        if (!flushEarly(operation)) return;
        operation.ready.resolve();
      }
      else if (event.type === 'ack') { operation.pendingAcks.delete(event.sequence); operation.hasAudioAck = true; }
      else if (event.type === 'caption' || event.type === 'status' || event.type === 'translation') emit(event);
      else if (event.type === 'complete') { operation.completed = true; operation.completion.resolve(event); }
      else if (event.type === 'error') halt(operation, new Error(event.message || '识别失败'));
    };
    ws.onerror = function () {
      if (!owns(operation) || operation.socket !== ws) return;
      var opened = operation.readySeen;
      halt(operation, new Error('私有语音连接失败'));
      // A socket refused before it opened is most often an expired private
      // session (the service restarted); sign in again instead of failing.
      if (!opened) json('/api/status').catch(function (error) { if (error.status === 401) signInAgain(); });
    };
    ws.onclose = function () {
      if (owns(operation) && operation.socket === ws && !operation.completed) {
        halt(operation, new Error('语音连接中断，已保留已收到的文字；请先停止设备录音'));
      }
    };
    await operation.ready.promise;
    requireOwner(operation);
    operation.ackTimer = setInterval(function () {
      if (!owns(operation)) return;
      var oldest = operation.pendingAcks.values().next().value;
      if (oldest && Date.now() - oldest > (operation.hasAudioAck ? ACK_TIMEOUT_MS : FIRST_ACK_TIMEOUT_MS)) {
        halt(operation, new Error('音频发送确认超时，接收已中断'));
      }
    }, 1000);
  }
  // An idle kept link watches for the physical key, so pressing it alone starts a recording.
  function arm(owner) {
    if (owner && owner.device && typeof owner.device.watch === 'function' && connection === owner && !owner.cancelled && connected && !current) owner.device.watch();
  }
  function createConnection() {
    if (!root.D3200Session) throw new Error('录音豆协议模块尚未加载');
    var owner = { device: null, cancelled: false, connecting: false };
    function valid() { return connection === owner && !owner.cancelled; }
    function operation() { return valid() && current && current.connection === owner ? current : null; }
    owner.initialize = function () { owner.device = new root.D3200Session(root.tt, {
      crypto: root.crypto,
      // One recording ending keeps the link, so the next one needs no reconnect.
      keepAlive: true,
      // The recorder streams only from the moment audio is asked for, so a key
      // press is looked for often: every listing waited for loses that audio.
      watchIntervalMs: 300, pollIntervalMs: 300,
      // Complete-frame support is a diagnostic capability, not iPhone acceptance.
      capabilities: { maxWriteBytes: 75 },
      onState: function (event) {
        if (!valid()) return;
        var phase = typeof event === 'string' ? event : event.phase || event.state;
        var active = operation();
        if (phase === 'streaming' && active) {
          try { bindVerifiedSource(active, event); }
          catch (error) { halt(active, error); return; }
          // Audio is arriving: the recording has started, whatever the service
          // says later about its realtime model.
          status('recording', '录音豆正在录音，正在接收…', active);
          return;
        }
        if (phase === 'crypto_ready' && event.transferEnded) {
          status(active ? 'finishing' : 'connected', active ? '设备音频接收已结束，正在确认最终文字' : '录音豆保持连接，可以开始下一段', active);
          return;
        }
        if (phase === 'stopped' || phase === 'completed') {
          var closed = event.connectionClosed === true;
          status(active ? 'finishing' : 'disconnected', active ? '设备音频接收已结束，正在确认最终文字' :
            (closed ? '设备连接已释放' : '接收已停止，设备断开状态尚未确认'), active);
          return;
        }
        status(phase || 'connecting', event.message || String(phase || '正在连接录音豆'), active);
      },
      onDevices: function (devices) { if (valid()) { owner.found = devices; emit({ type: 'devices', devices: devices }); } },
      // The physical key was pressed while the page was only connected.
      onRecordingDetected: function (event) { if (valid() && connected && !current) emit({ type: 'device_recording', fileId: event && event.fileId }); },
      onDeviceStatus: function (update) { if (valid() && connected) rememberDevice(Object.assign({}, update, { readAt: new Date().toISOString() })); },
      // Read while idle. `unreceived` is a recording the phone stopped receiving
      // (its stop never stops the recorder); it ends with the physical key.
      onRecorderState: function (state) {
        if (!valid() || !connected) return;
        rememberDevice({ recording: !!state.recording });
        var was = unreceived;
        unreceived = !!state.unreceived;
        if (unreceived && !was) buzz();
        emit({ type: 'recorder', recording: !!state.recording, unreceived: unreceived });
      },
      onDiagnostic: function (event) { if (valid()) diagnostic(event, operation()); },
      onFrame: function (frame) {
        var active = operation();
        if (active && active.early) {
          // The stream is still opening; hold the frame rather than lose it.
          if (active.early.length >= EARLY_FRAMES) {
            var overflow = new Error('私有语音服务迟迟未就绪，已停止接收');
            halt(active, overflow); throw overflow;
          }
          active.early.push(frame);
        } else if (active) {
          try { sendFrame(active, frame); }
          catch (error) { halt(active, error); throw error; }
        }
      },
      onEnd: function () {
        var active = operation();
        // A microtask must not stop a later recording after this BLE queue drains.
        Promise.resolve().then(function () { if (active && owns(active)) return runtime.stop(); }).catch(function (error) { fail(error, active); });
      },
      onError: function (error) {
        if (!valid()) return;
        var active = operation();
        if (active) halt(active, error);
        else if (error && error.code === 'DEVICE_DISCONNECTED') {
          // The recorder going away between recordings is not a failure to report.
          owner.cancelled = true;
          if (connection === owner) { connection = null; connected = false; }
          status('disconnected', '录音豆已断开，可以重新连接');
          deviceChanged();
        }
        else {
          // The session has failed and closed itself; the next connection starts fresh.
          fail(error);
          owner.cancelled = true;
          if (connection === owner) connection = null;
          connected = false; deviceChanged();
        }
      }
    }); };
    return owner;
  }
  var runtime = {
    subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
    init: async function () {
      apiStatus = await json('/api/status');
      initialized = true;
      var models = apiStatus.models || { stepfun: true, doubao: false };
      return { capabilities: { capture: true, summary: true, translation: true, speakers: !!apiStatus.speakerDiarization, documents: !!apiStatus.automaticDocuments,
        models: { stepfun: models.stepfun !== false, doubao: models.doubao === true } }, sourceLabel: sourceLabel,
        connected: connected, jsapiConfigured: apiStatus.jsapiConfigured, speakerDiarization: !!apiStatus.speakerDiarization,
        device: device ? deviceSnapshot() : null };
    },
    connect: async function (options) {
      if (current) throw new Error('已有录音正在接收');
      if (connection && connection.connecting) throw new Error('正在连接录音豆');
      if (connected) return { connected: true, sourceLabel: sourceLabel, device: deviceSnapshot() };
      var picked = options && options.deviceId, previous = connection;
      // Only a device picked from the listing just shown reuses that session;
      // anything else (a dismissed listing, a failed session) starts fresh.
      if (previous && previous.device && !(picked && previous.device.state === 'selection_ready')) {
        previous.cancelled = true; connection = null;
        previous.device.disconnect().catch(function () {});
      }
      var owner = connection || createConnection();
      connection = owner;
      owner.connecting = true;
      try {
        if (!initialized) await runtime.init();
        await sdk();
        if (connection !== owner || owner.cancelled) throw new Error('连接已取消');
        if (!owner.device) owner.initialize();
        var deviceId = options && options.deviceId;
        if (!deviceId) {
          status('scanning', '正在查找附近的录音豆');
          var devices = await owner.device.scan({ durationMs: 8000 });
          if (connection !== owner || owner.cancelled) throw new Error('连接已取消');
          if (!devices.length) throw new Error('未发现录音豆，请保持设备唤醒并释放原页面的连接');
          if (devices.length !== 1) return { connected: false, devices: devices, sourceLabel: sourceLabel };
          deviceId = devices[0].deviceId;
        }
        var linked = await owner.device.connect({ deviceId: deviceId });
        if (connection !== owner || owner.cancelled) throw new Error('连接已取消');
      } catch (error) {
        owner.cancelled = true;
        if (connection === owner) { connection = null; connected = false; }
        if (owner.device) await owner.device.disconnect().catch(function () {});
        throw error;
      } finally { owner.connecting = false; }
      connected = true;
      var info = linked && linked.deviceInfo || {}, readAt = new Date().toISOString();
      var seen = (owner.found || []).find(function (item) { return item.deviceId === deviceId; });
      var bound = seen && typeof seen.boundAdvertised === 'boolean' ? seen.boundAdvertised : null;
      // A fresh reading replaces every status field, so a value the device no
      // longer reports cannot survive from an older reading.
      device = Object.assign({ boundAdvertised: device && device.boundAdvertised, boundReadAt: device && device.boundReadAt },
        bound === null ? {} : { boundAdvertised: bound, boundReadAt: readAt });
      rememberDevice(Object.assign({ firmware: /^[0-9][0-9.]{2,4}$/.test(info.firmware || '') ? info.firmware : null, readAt: readAt }, info.status || {}));
      status('connected', '录音豆加密握手已验证');
      // A new link has not stopped receiving anything yet.
      unreceived = false;
      emit({ type: 'recorder', recording: !!device.recording, unreceived: false });
      arm(owner);
      return { connected: true, sourceLabel: sourceLabel, device: deviceSnapshot() };
    },
    start: async function (options) {
      if (!connected || !connection) throw new Error('请先连接录音豆');
      if (current) throw new Error('已有录音正在接收');
      if (!options || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(options.recordingId)) throw new Error('录音标识无效');
      var language = options.language || 'zh';
      if (language !== 'zh' && language !== 'en') throw new Error('请选择中文或英文识别');
      // 'none' records audio only; the text then comes from the file model.
      var liveModel = options.liveModel || 'stepfun', fileModel = options.fileModel || null;
      if (['stepfun', 'doubao', 'none'].indexOf(liveModel) === -1 || (fileModel && ['stepfun', 'doubao'].indexOf(fileModel) === -1) ||
          (liveModel === 'none' && !fileModel)) throw new Error('请选择可用的识别模型');
      // A key press already noticed names its file: the recorder only streams
      // from the moment audio is asked for, so ask at once and let the private
      // stream open alongside.
      var pressed = Number.isInteger(options.fileId);
      var operation = { recordingId: options.recordingId, title: options.title || 'soundcore Work 录音', connection: connection, cancelled: false,
        liveModel: liveModel, fileModel: fileModel, early: pressed ? [] : null,
        ready: deferred(), completion: deferred(), pendingAcks: new Map(), hasAudioAck: false,
        verifiedSource: null, sourceIdentitySent: false,
        socket: null, stopPromise: null };
      current = operation;
      function read() { operation.connection.device.startLive(pressed ? options.fileId : undefined).catch(function (error) { halt(operation, error); }); }
      try {
        if (pressed) read();
        await openSocket(operation, language);
        requireOwner(operation);
        if (!pressed) read();
        if (pressed) status('recording', '录音豆正在录音，正在接收…', operation);
        else status('waiting', '接收已准备好，请按录音豆实体键开始录音', operation);
        return { phase: pressed ? 'recording' : 'waiting', startedAt: new Date().toISOString() };
      } catch (error) {
        if (owns(operation)) halt(operation, error);
        throw error;
      }
    },
    stop: function () {
      var operation = current;
      if (!operation) return Promise.reject(new Error('没有正在接收的录音'));
      if (operation.stopPromise) return operation.stopPromise;
      operation.stopPromise = (async function () {
        status('finishing', '正在收尾，请确认录音豆已停止录音', operation);
        var cleanup = await operation.connection.device.endTransfer({ drain: true });
        requireOwner(operation);
        await operation.ready.promise;
        requireOwner(operation);
        var deadline = Date.now() + 15000;
        while (operation.pendingAcks.size && Date.now() < deadline && operation.socket && operation.socket.readyState === WebSocket.OPEN) {
          await new Promise(function (resolve) { setTimeout(resolve, 40); });
          requireOwner(operation);
        }
        if (operation.pendingAcks.size) throw new Error('尾部音频未全部确认，未标记录音完成');
        var ws = operation.socket;
        if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('语音连接已断开，音频收尾未完成');
        ws.send(JSON.stringify({ type: 'stop' }));
        var timer;
        var result = await Promise.race([operation.completion.promise, new Promise(function (_, reject) {
          timer = setTimeout(function () { reject(new Error('最终文字等待超时')); }, COMPLETE_TIMEOUT_MS);
        })]).finally(function () { clearTimeout(timer); });
        requireOwner(operation);
        if (result.recordingId !== operation.recordingId || !result.audio || result.audio.url !== apiPath('/api/audio/' + operation.recordingId)) {
          throw new Error('音频与录音标识不匹配');
        }
        result.deviceCleanup = cleanup;
        // The service now holds the audio and the final text. The phone's own
        // copy follows (audio_cached) and is best effort: a failed or slow
        // download never fails the recording or holds the next one back.
        emit({ type: 'audio', recordingId: operation.recordingId, audio: result.audio, durationMs: result.durationMs,
          segments: result.segments, silenceRanges: result.silenceRanges || [] });
        operation.kept = !!(cleanup && cleanup.connectionKept);
        status('stopped', operation.kept ? '录音与最终文字已保存，录音豆保持连接' : cleanup && cleanup.connectionClosed === true ? '录音与最终文字已保存，设备连接已释放' :
          '录音与最终文字已保存；设备断开状态尚未确认', operation);
        cacheAudio(operation.recordingId, result.audio.url);
        return result;
      })().catch(function (error) { fail(error, operation); throw error; }).finally(function () {
        clearSocket(operation);
        if (current === operation) current = null;
        var owner = operation.connection;
        // A saved recording keeps the link; any failure releases it so the next
        // connection starts from a clean handshake.
        if (!operation.kept || owner.cancelled || connection !== owner) {
          if (connection === owner) { connection = null; connected = false; }
          owner.cancelled = true;
          owner.device.disconnect().catch(function () {});
        } else arm(owner);
        deviceChanged();
      });
      return operation.stopPromise;
    },
    // Cancel before any audio arrives, keeping the link for the next recording.
    abort: async function () {
      var operation = current;
      if (!operation || operation.stopPromise) return;
      current = null;
      cancel(operation, new Error('接收已取消'));
      var owner = operation.connection;
      try { await owner.device.endTransfer({ drain: false }); }
      catch (_) { if (connection === owner) await runtime.disconnect(); return; }
      if (connection === owner && !owner.cancelled) { status('connected', '已取消，录音豆保持连接'); arm(owner); }
      deviceChanged();
    },
    disconnect: async function () {
      // Invalidate synchronously, before awaiting the old BLE cleanup.
      var owner = connection, operation = current;
      current = null; connection = null; connected = false;
      if (owner) owner.cancelled = true;
      cancel(operation, new Error('接收已取消'));
      deviceChanged();
      var cleanup = owner && owner.device ? await owner.device.disconnect() : null;
      if (!connection && !current) status('disconnected', cleanup && cleanup.connectionClosed === true ? '连接已释放' :
        '接收已取消，设备断开状态尚未确认');
    },
    device: function () { return device ? deviceSnapshot() : null; },
    // Recordings kept on the recorder itself. Only on an idle link: a recording
    // being received owns it, and deleting is only ever what the user picked.
    listDeviceFiles: async function () { return idleLink().device.listAllFiles(); },
    deleteDeviceFiles: async function (options) {
      var owner = idleLink(), ids = options && Array.isArray(options.fileIds) ? options.fileIds : [];
      if (!ids.length || ids.length > MAX_DELETE || !ids.every(function (id) { return uint32(id) && id > 0; })) throw new Error('请选择要删除的录音');
      var result = await owner.device.deleteFiles(ids);
      // Storage changed; a failed re-read only leaves the old figure.
      try { rememberDevice(Object.assign({}, await owner.device.readStatus(), { readAt: new Date().toISOString() })); } catch (_) {}
      return result;
    },
    summarize: function (options) { return json('/api/text/summary', options); },
    createDocument: function (options) { return json('/api/recordings/' + encodeURIComponent(options.recordingId) + '/document', {}); },
    getDocument: function (options) { return json('/api/recordings/' + encodeURIComponent(options.recordingId) + '/document'); },
    translate: function (options) { return json('/api/text/translation', options); },
    identifySpeakers: function (options) { return json('/api/recordings/' + encodeURIComponent(options.recordingId) + '/speakers', options.provider ? { provider: options.provider } : {}); },
    getSpeakers: function (options) { return json('/api/recordings/' + encodeURIComponent(options.recordingId) + '/speakers'); },
    applySpeakers: function (options) { return json('/api/recordings/' + encodeURIComponent(options.recordingId) + '/speakers/apply', { expectedContentVersion: options.expectedContentVersion }); },
    listRecordings: async function () { return (await json('/api/recordings')).recordings; },
    getRecording: function (options) { return json('/api/recordings/' + encodeURIComponent(options.recordingId)); },
    saveRecording: function (record) {
      var allowed = ['schemaVersion', 'id', 'title', 'sourceLabel', 'createdAt', 'updatedAt', 'startedAt', 'endedAt',
        'state', 'durationMs', 'segments', 'audioMimeType', 'summary', 'chapters', 'summaryStatus',
        'summaryError', 'translationStatus', 'translationError', 'silenceRanges', 'sourceType',
        'language', 'summaryStale', 'speakerDiarization', 'contentEdited', 'sourceVersion'];
      var data = {};
      allowed.forEach(function (key) { if (record[key] !== undefined) data[key] = record[key]; });
      return json('/api/recordings', data);
    }
  };
  root.MinutesRuntime = runtime;
  var requestedRecording = new URL(location.href).searchParams.get('recording');
  if (requestedRecording && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(requestedRecording)) runtime.initialRecordingId = requestedRecording;
}(window));
