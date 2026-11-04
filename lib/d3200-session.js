/* Explicit-user-start D3200 reader for Feishu H5 JSAPI. No recording/control commands. */
var wire = require('./ble-frame');
var ble = require('./feishu-ble');
var D3200Crypto = require('./d3200-crypto');
var ownership = new WeakMap();
function error(code, message) { var result = new Error(message); result.code = code; return result; }
function bounded(value, fallback, min, max, name) {
  value = value === undefined ? fallback : value;
  if (!Number.isInteger(value) || value < min || value > max) throw error('CONFIGURATION', 'Invalid ' + name);
  return value;
}
function deferred() {
  var resolve, reject;
  var promise = new Promise(function (yes, no) { resolve = yes; reject = no; });
  promise.catch(function () {}); // The operation may be cancelled before a consumer awaits it.
  return { promise: promise, resolve: resolve, reject: reject };
}
function u32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
// One page of the recorder's file list: a uint16 count, then 8-byte entries
// (start time = file id, duration ms) or 12-byte ones (start, end, duration),
// then the file being recorded (0 when none) and its duration. Pages hold ten.
var FILE_PAGE = 10, DELETE_TIMEOUT_MS = 3000;
// One 20 ms audio slice on the recorder; a fresh recording younger than
// FRESH_SECONDS is read from its second slice instead of from "now".
var SLICE_BYTES = 166, FRESH_SECONDS = 30;
// Idle listings failing this many times in a row mean the link is gone.
var WATCH_FAILURES = 8;
// A key exchange made for a noticed recording is reused this long. A noticed
// recording that no transfer follows within it is watched for again.
var PREPARED_MS = 15000;
function freshStats() { return { audioFrames: 0, audioBytes: 0, duplicates: 0, sequenceGaps: 0, firstSequence: null, lastSequence: null }; }
function isFileList(packet) { return [26, 27].includes(packet.type) && packet.id === 14; }
function fileListPage(packet) {
  var data = new Uint8Array(packet.payload);
  if (data.length < 2) throw error('FILE_LIST_LAYOUT', 'File-list response is too short');
  var count = data[0] | (data[1] << 8), width = packet.type === 27 ? 12 : 8, offset = 2 + count * width;
  if (count > 1000 || data.length < offset + 8) throw error('FILE_LIST_LAYOUT', 'File-list response lacks the active-recording trailer');
  var files = [];
  for (var at = 2; at < offset; at += width) files.push({ fileId: u32(data, at), durationMs: u32(data, at + width - 4) });
  return { files: files, active: u32(data, offset) };
}
// D3200 reports battery as a 0..9 bucket shown as (bucket + 1) x 10%; values
// above 9 are literal percentages. Anything else stays unknown.
function batteryPercent(value) { return Number.isInteger(value) ? (value <= 9 ? (value + 1) * 10 : value <= 100 ? value : null) : null; }
function binaryFlag(value) { return value === 0 || value === 1 ? value === 1 : null; }
function versionText(bytes, start) {
  if (bytes.length < start + 5) return null;
  var text = String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, start, start + 5));
  return /^[0-9][0-9.]{2,4}$/.test(text) ? text : null;
}
// Device-info body layout (tacshi/Soundcore PROTOCOL.md section 6.1), checked
// against this recorder's 65-byte reply. The serial number (8..23) and the
// charging-case MAC (39..44) identify hardware and are deliberately not read.
function deviceStatus(payload) {
  var bytes = new Uint8Array(payload), storage = null;
  if (bytes.length >= 32) {
    var total = u32(bytes, 24), free = u32(bytes, 28);
    if (total > 0 && free <= total) storage = { totalKB: total, freeKB: free };
  }
  return { micBattery: bytes.length > 1 ? batteryPercent(bytes[1]) : null, micCharging: bytes.length > 2 ? binaryFlag(bytes[2]) : null,
    storage: storage, caseCharging: bytes.length > 32 ? binaryFlag(bytes[32]) : null, caseFirmware: versionText(bytes, 33),
    caseBattery: bytes.length > 38 ? batteryPercent(bytes[38]) : null, recording: bytes.length > 50 ? binaryFlag(bytes[50]) : null,
    wifiFirmware: versionText(bytes, 51) };
}
// Manufacturer data starts with the six-byte device address; byte 6 bit 7 is
// the vendor-binding flag. Unknown layouts report null, never "unbound".
function boundFromAdvertisement(data) {
  var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
  return bytes && bytes.length >= 7 ? (bytes[6] & 0x80) !== 0 : null;
}
function normalized(value) { return ble.normalizeUuid(value); }
function D3200Session(tt, options) {
  options = options || {};
  if (!tt || typeof tt !== 'object') throw error('API_UNAVAILABLE', 'An initialized Feishu JSAPI object is required');
  this.api = tt;
  this.options = options;
  this.capabilities = { maxWriteBytes: options.capabilities && options.capabilities.maxWriteBytes !== undefined ? options.capabilities.maxWriteBytes : 20 };
  if (![20, 75].includes(this.capabilities.maxWriteBytes)) throw error('CONFIGURATION', 'maxWriteBytes must be 20 or an explicit diagnostic 75');
  this.transportCapability = { maxWriteBytes: this.capabilities.maxWriteBytes, wholeFrame75Diagnostic: this.capabilities.maxWriteBytes === 75, deviceValidated: false };
  this.apiTimeoutMs = bounded(options.apiTimeoutMs, 10000, 1, 60000, 'API timeout');
  this.ackTimeoutMs = bounded(options.ackTimeoutMs, 10000, 1, 60000, 'ACK timeout');
  this.pollIntervalMs = bounded(options.pollIntervalMs, 3000, 1, 60000, 'poll interval');
  // Idle watching decides how soon a key press is noticed. A live read starts
  // at the recorder's current position, so every second of it is audio the
  // live stream never carries.
  this.watchIntervalMs = bounded(options.watchIntervalMs, 1000, 1, 60000, 'watch interval');
  // A listing the recorder leaves unanswered (it can, while starting a file)
  // is asked again after this, not after the full ACK timeout.
  this.listTimeoutMs = bounded(options.listTimeoutMs, 2000, 1, 60000, 'listing timeout');
  this.preparedMs = bounded(options.preparedMs, PREPARED_MS, 1, 60000, 'prepared key window');
  this.frameTimeoutMs = bounded(options.frameTimeoutMs, 15000, 1, 60000, 'frame delivery timeout');
  this.maxQueuedBytes = bounded(options.maxQueuedBytes, 262144, 166, 1048576, 'receive queue limit');
  this.maxQueuedPackets = bounded(options.maxQueuedPackets, 512, 1, 4096, 'receive packet limit');
  this.state = 'idle'; this.epoch = 1; this.deviceId = null; this.connected = false;
  this._serviceId = null; this._writerId = null; this._notifierId = null;
  this._operations = new Set(); this._timers = new Set(); this._listeners = [];
  this._queue = []; this._queuedBytes = 0; this._busy = false; this._pumpPromise = Promise.resolve();
  this._pending = null; this._transfer = null; this._pollTimer = null; this._accepting = false;
  this._closing = false; this._stopPromise = null; this._failure = null; this._fileDone = false;
  this._crypto = null; this._decoder = new wire.FrameDecoder();
  this.mode = null; this.currentFile = null; this.lastSequence = null;
  this.stats = freshStats();
  this._ending = false; this._endPromise = null; this._endedFile = null; this._lastEnd = null; this._transferSerial = 0;
  this._watching = false; this._watchTimer = null; this._prepared = null; this._preparing = null; this._recorder = null;
  this._rearmTimer = null; this._managingCount = 0; this._resumeAfterManaging = false;
  if (!ownership.has(tt)) ownership.set(tt, { scan: null, devices: new Map() });
  this._owners = ownership.get(tt);
}
D3200Session.prototype._emit = function (name, value) {
  if (typeof this.options[name] === 'function') {
    try { return this.options[name](value); } catch (exception) { if (name === 'onFrame') throw exception; }
  }
};
D3200Session.prototype._state = function (value, detail) {
  this.state = value;
  this._emit('onState', Object.assign({ state: value, phase: value, sourceType: this.mode === 'replay' ? 'device_recorded_file_replay' : this.mode === 'live' ? 'live_device_recording' : null }, detail || {}));
};
D3200Session.prototype._check = function (epoch) {
  if (epoch !== this.epoch || this._closing) throw error('CANCELLED', 'D3200 operation cancelled');
};
// A transfer that was ended mid-start must not resume after an await.
D3200Session.prototype._checkTransfer = function (serial) {
  if (serial !== undefined && serial !== this._transferSerial) throw error('CANCELLED', 'Recording ended');
};
D3200Session.prototype._timer = function (fn, delay) {
  var self = this;
  var handle = setTimeout(function () { self._timers.delete(handle); fn(); }, delay);
  this._timers.add(handle); return handle;
};
D3200Session.prototype._clearTimer = function (handle) { clearTimeout(handle); this._timers.delete(handle); };
D3200Session.prototype._wait = function (promise, ms, code) {
  var self = this, task = deferred(), done = false;
  function settle(failure, result) {
    if (done) return; done = true; self._clearTimer(timer); self._operations.delete(cancel);
    if (failure) task.reject(failure); else task.resolve(result);
  }
  function cancel(reason) { settle(reason || error('CANCELLED', 'Operation cancelled')); }
  var timer = this._timer(function () { settle(error(code, 'Timed out waiting for ' + code)); }, ms);
  this._operations.add(cancel);
  Promise.resolve(promise).then(function (value) { settle(null, value); }, function (failure) { settle(failure); });
  return task.promise;
};
D3200Session.prototype._cleanupApi = function (name, parameters) {
  var api = this.api;
  if (typeof api[name] !== 'function') return Promise.resolve({ ok: false, api: name, code: 'UNAVAILABLE' });
  return new Promise(function (resolve) {
    var done = false, timer = setTimeout(function () { finish(false, 'TIMEOUT'); }, 1500);
    function finish(ok, code) { if (done) return; done = true; clearTimeout(timer); resolve({ ok: ok, api: name, code: code || null }); }
    try { api[name](Object.assign({}, parameters, { success: function () { finish(true); }, fail: function (res) { finish(false, res && (res.errno || res.errCode)); } })); }
    catch (_) { finish(false, 'THREW'); }
  });
};
D3200Session.prototype._call = function (name, parameters, lateCleanup) {
  var self = this, epoch = this.epoch;
  this._check(epoch);
  if (typeof this.api[name] !== 'function') return Promise.reject(error('API_UNAVAILABLE', 'Feishu API unavailable: ' + name));
  var result = deferred();
  try {
    this.api[name](Object.assign({}, parameters, {
      success: function (response) {
        if (epoch !== self.epoch || self._closing) { if (lateCleanup) lateCleanup(); return; }
        result.resolve(response || {});
      },
      fail: function (response) {
        var failure = error('BLE_API_FAILED', 'Feishu API failed: ' + name);
        failure.api = name; failure.platformCode = response && (response.errno || response.errCode);
        result.reject(failure);
      }
    }));
  } catch (_) { result.reject(error('BLE_API_FAILED', 'Feishu API threw: ' + name)); }
  return this._wait(result.promise, this.apiTimeoutMs, 'BLE_API_TIMEOUT').catch(function (failure) {
    failure.api = name;
    throw failure;
  });
};
D3200Session.prototype._listen = function (name, offName, callback) {
  if (typeof this.api[name] !== 'function' || typeof this.api[offName] !== 'function') throw error('API_UNAVAILABLE', 'Feishu event API unavailable: ' + name);
  this._listeners.push({ off: offName, callback: callback });
  this.api[name](callback);
};
D3200Session.prototype._unlisten = function (offName) {
  var api = this.api;
  this._listeners = this._listeners.filter(function (item) {
    if (offName && item.off !== offName) return true;
    try { api[item.off](item.callback); } catch (_) {}
    return false;
  });
};
D3200Session.prototype.scan = async function (options) {
  if (this.state !== 'idle') throw error('SESSION_STATE', 'Create a fresh session before scanning');
  options = options || {};
  var duration = bounded(options.durationMs, 8000, 1, 30000, 'scan duration');
  var self = this, epoch = this.epoch, devices = new Map();
  var scanStats = { type: 'scan_complete', eventCount: 0, advertisedCount: 0, cachedCount: 0, connectedCount: 0, matchedCount: 0 };
  function collect(list, source) {
    if (epoch !== self.epoch || self._closing || !Array.isArray(list)) return;
    list.slice(0, 100).forEach(function (device) {
      if (!device || typeof device.deviceId !== 'string' || !device.deviceId || device.deviceId.length > 256 || devices.size >= 100) return;
      var services = Array.isArray(device.advertisServiceUUIDs) ? device.advertisServiceUUIDs.map(normalized) : [];
      var name = String(device.localName || device.name || '').slice(0, 128);
      // The connected-device lookup is already scoped to this exact service.
      // Names/UUIDs from unrelated advertisements never leave this process.
      if (source !== 'connected' && !services.includes(ble.SERVICE) && !/soundcore\s*work|d3200/i.test(name)) return;
      var previous = devices.get(device.deviceId), bound = boundFromAdvertisement(device.advertisData);
      devices.set(device.deviceId, { deviceId: device.deviceId, name: name || previous && previous.name || 'soundcore Work',
        RSSI: Number.isFinite(device.RSSI) ? device.RSSI : previous && previous.RSSI || null,
        serviceAdvertised: services.includes(ble.SERVICE) || !!(previous && previous.serviceAdvertised),
        boundAdvertised: bound !== null ? bound : previous ? previous.boundAdvertised : null,
        discoverySource: previous && previous.discoverySource === 'advertisement' ? 'advertisement' : source });
    });
    self._emit('onDevices', Array.from(devices.values()));
  }
  async function lookup(name, parameters, source, field) {
    if (typeof self.api[name] !== 'function') return;
    try {
      var response = await self._call(name, parameters); self._check(epoch);
      var found = Array.isArray(response.devices) ? response.devices : [];
      scanStats[field] = Math.min(found.length, 100);
      collect(found, source);
    } catch (failure) {
      if (failure.code === 'CANCELLED') throw failure;
      self._emit('onDiagnostic', { type: 'scan_lookup_failed', api: name, code: failure.code, platformCode: failure.platformCode });
    }
  }
  try {
    this._state('opening_bluetooth');
    await this._call('openBluetoothAdapter', {}); this._check(epoch);
    this._owners.scan = this;
    this._listen('onBluetoothDeviceFound', 'offBluetoothDeviceFound', function (event) {
      if (epoch !== self.epoch || self._closing || self.state !== 'scanning') return;
      var found = event && Array.isArray(event.devices) ? event.devices : [];
      scanStats.eventCount = Math.min(scanStats.eventCount + 1, 10000);
      scanStats.advertisedCount = Math.min(scanStats.advertisedCount + found.length, 10000);
      collect(found, 'advertisement');
    });
    this._state('scanning');
    await this._call('startBluetoothDevicesDiscovery', { services: [ble.SERVICE], allowDuplicatesKey: false, interval: 0 }, function () {
      if (self._owners.scan === self) self._cleanupApi('stopBluetoothDevicesDiscovery', {});
    });
    await this._wait(new Promise(function (resolve) { self._timer(resolve, duration); }), duration + this.apiTimeoutMs, 'SCAN_TIMEOUT');
    this._check(epoch);
    await this._call('stopBluetoothDevicesDiscovery', {});
    this._unlisten('offBluetoothDeviceFound');
    // iOS may retain a peripheral without emitting a fresh discovery event.
    await lookup('getBluetoothDevices', {}, 'cached', 'cachedCount');
    await lookup('getConnectedBluetoothDevices', { services: [ble.SERVICE] }, 'connected', 'connectedCount');
    this._check(epoch);
    scanStats.matchedCount = devices.size;
    this._emit('onDiagnostic', scanStats);
    this._state('selection_ready', { devicesFound: devices.size });
    return Array.from(devices.values());
  } catch (failure) { if (failure.code !== 'CANCELLED') this._fail(failure); throw failure; }
};
D3200Session.prototype.connect = async function (selection) {
  if (!['idle', 'selection_ready'].includes(this.state) || this._closing) throw error('SESSION_STATE', 'Session cannot connect in its current state');
  if (!selection || typeof selection.deviceId !== 'string' || !selection.deviceId.trim() || selection.deviceId.length > 256) throw error('DEVICE_SELECTION', 'Explicitly select a device ID');
  var self = this, epoch = this.epoch;
  this.deviceId = selection.deviceId;
  this._owners.devices.set(this.deviceId, this);
  try {
    this._state('opening_bluetooth');
    await this._call('openBluetoothAdapter', {}); this._check(epoch);
    this._listen('onBLEConnectionStateChange', 'offBLEConnectionStateChange', function (event) {
      if (epoch !== self.epoch || self._closing || !event || event.deviceId !== self.deviceId) return;
      if (event.connected === false || event.connected === 'false') self._fail(error('DEVICE_DISCONNECTED', 'The selected recording device disconnected'));
    });
    this._state('connecting');
    await this._call('connectBLEDevice', { deviceId: this.deviceId }, function () {
      if (self._owners.devices.get(self.deviceId) === self) self._cleanupApi('disconnectBLEDevice', { deviceId: self.deviceId });
    });
    this._check(epoch); this.connected = true; this._state('discovering');
    var services = await this._call('getBLEDeviceServices', { deviceId: this.deviceId }); this._check(epoch);
    var matches = (services.services || []).filter(function (service) { return normalized(service.serviceId) === ble.SERVICE; });
    if (matches.length !== 1) throw error('SERVICE_MISMATCH', 'Expected exactly one D3200 service');
    // iOS may report the short CoreBluetooth UUID spelling. Reuse that exact
    // identifier for subsequent JSAPI calls after normalizing only to validate it.
    this._serviceId = matches[0].serviceId;
    this._emit('onDiagnostic', { type: 'service_selected', command: { reportedService: this._serviceId, normalizedService: ble.SERVICE } });
    var result = await this._call('getBLEDeviceCharacteristics', { deviceId: this.deviceId, serviceId: this._serviceId }); this._check(epoch);
    var chars = Array.isArray(result.characteristics) ? result.characteristics : [];
    var writer = chars.filter(function (c) { return normalized(c.characteristicId) === ble.WRITER && c.properties && c.properties.write === true; });
    var notifier = chars.filter(function (c) { return normalized(c.characteristicId) === ble.NOTIFIER && c.properties && (c.properties.notify === true || c.properties.indicate === true); });
    if (writer.length !== 1 || notifier.length !== 1) throw error('CHARACTERISTIC_MISMATCH', 'Exact D3200 writable and notify characteristics are required');
    this._writerId = writer[0].characteristicId; this._notifierId = notifier[0].characteristicId;
    this._accepting = true;
    this._listen('onBLECharacteristicValueChange', 'offBLECharacteristicValueChange', function (event) { self._notification(event, epoch); });
    this._state('subscribing');
    await this._call('notifyBLECharacteristicValueChange', { deviceId: this.deviceId, serviceId: this._serviceId,
      characteristicId: this._notifierId, state: true, type: notifier[0].properties.notify ? 'notify' : 'indicate' });
    this._check(epoch); this._state('awaiting_info');
    var info = await this._request(wire.readDeviceInfo(), function (p) { return p.type === 1 && p.id === 1; }, function (packet) {
      if (packet.payload.length < 8) throw error('DEVICE_INFO_LAYOUT', 'Device information response is too short');
      // REA: obf.n.b reads these optional bytes at raw offsets 71/72.
      // FrameDecoder has already removed the 9-byte header and checksum.
      // Missing or non-binary values remain unknown instead of declaring no auth.
      var support = packet.payload.length >= 63 ? packet.payload[62] : null;
      var bound = packet.payload.length >= 64 ? packet.payload[63] : null;
      return { firmware: String.fromCharCode.apply(null, packet.payload.slice(3, 8)),
        recordingRaw: packet.payload.length > 50 ? packet.payload[50] : null,
        deviceInfoBytes: packet.payload.length, supportAuthRaw: support, hasAuthUidRaw: bound,
        supportAuth: support === 0 || support === 1 ? support === 1 : null,
        hasAuthUid: bound === 0 || bound === 1 ? bound === 1 : null,
        status: deviceStatus(packet.payload) };
    });
    this._check(epoch);
    this._emit('onDiagnostic', { type: 'device_info_capability', command: '01/01',
      deviceInfoBytes: info.deviceInfoBytes, supportAuthRaw: info.supportAuthRaw, hasAuthUidRaw: info.hasAuthUidRaw,
      supportAuth: info.supportAuth, hasAuthUid: info.hasAuthUid });
    await this._exchangeSessionKey('connection');
    this._check(epoch);
    this.transportCapability.deviceValidated = this.capabilities.maxWriteBytes === 75;
    this._state('crypto_ready', { deviceInfo: info, capability: this.transportCapability });
    return { deviceId: this.deviceId, deviceInfo: info, cryptoReady: true, capability: Object.assign({}, this.transportCapability) };
  } catch (failure) { if (failure.code !== 'CANCELLED') this._fail(failure); throw failure; }
};
// `quiet` negotiates ahead without moving the session state (idle stays crypto_ready).
D3200Session.prototype._exchangeSessionKey = async function (reason, serial, quiet) {
  var self = this, epoch = this.epoch;
  this._check(epoch);
  if (this._crypto) this._crypto.destroy();
  var crypto = this._crypto = new D3200Crypto(this.options.crypto);
  var publicKey = await crypto.createPublicKey(); this._check(epoch); this._checkTransfer(serial);
  if (!quiet) this._state('awaiting_key', { capability: this.transportCapability,
    message: reason === 'audio_start' ? '正在为本段录音重新协商会话密钥' : '正在协商录音豆会话密钥' });
  await this._request(wire.ephemeralPublicKey(publicKey), function (p) { return p.type === 46 && p.id === 1; }, async function (packet) {
    if (!quiet) self._state('verifying_key', { message: '正在校验录音豆密钥响应' });
    var verified = await crypto.acceptHandshake(packet.payload);
    self._check(epoch); return verified;
  });
  this._check(epoch);
  this._emit('onDiagnostic', { type: 'key_exchange_verified', command: reason });
};
D3200Session.prototype._request = function (frame, match, process, timeoutMs) {
  var self = this, epoch = this.epoch;
  this._check(epoch);
  if (this._pending) return Promise.reject(error('REQUEST_OVERLAP', 'A device ACK is already pending'));
  var value = wire.prepareWrite(frame, this.capabilities), ack = deferred();
  var pending = { match: match, process: process, resolve: ack.resolve, reject: ack.reject };
  this._pending = pending;
  var ackWait = this._wait(ack.promise, timeoutMs || this.ackTimeoutMs, 'DEVICE_ACK_TIMEOUT');
  var write = this._call('writeBLECharacteristicValue', { deviceId: this.deviceId, serviceId: this._serviceId, characteristicId: this._writerId, value: value });
  return Promise.all([write, ackWait]).then(function (results) { self._check(epoch); return results[1]; }).finally(function () {
    if (self._pending === pending) self._pending = null;
  });
};
D3200Session.prototype._notification = function (event, epoch) {
  if (epoch !== this.epoch || this._closing || !this._accepting) return;
  try {
    var previousBad = this._decoder.invalidFrames;
    var selected = event && event.deviceId === this.deviceId && normalized(event.serviceId) === ble.SERVICE && normalized(event.characteristicId) === ble.NOTIFIER;
    var rejection = selected ? wire.authenticationRejection(event.value) : null;
    if (rejection) rejection.reassembled = false;
    var packets = rejection ? [rejection] : ble.notificationFrames(this._decoder, this.deviceId, event);
    if (this._decoder.invalidFrames !== previousBad) throw error('BLE_FRAME_CHECKSUM', 'Invalid BLE packet checksum or length');
    var self = this;
    packets.forEach(function (packet) {
      // A recording that is being ended keeps only what was already queued.
      if (self._ending && [26, 27].includes(packet.type)) return;
      var size = packet.payload.length + 10;
      if (self._queuedBytes + size > self.maxQueuedBytes || self._queue.length >= self.maxQueuedPackets) throw error('AUDIO_QUEUE_OVERFLOW', 'Audio delivery cannot keep up with the BLE stream');
      self._queue.push({ packet: packet, bytes: size, receivedAtMs: Date.now() }); self._queuedBytes += size;
    });
    if (!this._busy && this._queue.length) this._pumpPromise = this._pump(epoch);
  } catch (failure) { this._fail(failure); }
};
D3200Session.prototype._pump = async function (epoch) {
  this._busy = true;
  try {
    while (this._queue.length && epoch === this.epoch && !this._closing) {
      var item = this._queue.shift();
      try { await this._handle(item, epoch); } finally { if (epoch === this.epoch) this._queuedBytes -= item.bytes; }
    }
  } catch (failure) { if (failure.code !== 'CANCELLED') this._fail(failure); }
  finally {
    this._busy = false;
    if (epoch === this.epoch && this._fileDone && !this._queue.length && !this._closing) this._complete();
  }
};
D3200Session.prototype._handle = async function (item, epoch) {
  var packet = item.packet, pending = this._pending;
  if (packet.authenticationRejected) {
    var authentication = error('DEVICE_AUTH_REJECTED', '设备拒绝未通过连接鉴权的命令；ECDH 不能替代已绑定设备的连接鉴权');
    authentication.command = { type: packet.type, id: packet.id };
    authentication.authenticationCode = packet.authenticationCode;
    authentication.diagnosticRawHex = packet.diagnosticRawHex;
    authentication.notificationBytes = packet.notificationBytes;
    authentication.reassembled = packet.reassembled;
    authentication.checksumVerified = false;
    this._emit('onDiagnostic', { type: 'authentication_rejection', command: authentication.command,
      code: packet.authenticationCode, rawPrefixHex: packet.diagnosticRawHex, notificationBytes: packet.notificationBytes,
      reassembled: packet.reassembled, checksumVerified: false, interpretationBasis: 'Android SDK static predicate' });
    throw authentication;
  }
  if (pending && pending.match(packet)) {
    this._pending = null;
    if (packet.status !== 1) { pending.reject(error('DEVICE_ACK_REJECTED', 'Device rejected command ' + packet.type + '/' + packet.id)); return; }
    try { var result = await pending.process(packet); this._check(epoch); pending.resolve(result); }
    catch (failure) { pending.reject(failure); throw failure; }
    return;
  }
  // Unsolicited device pushes: 01/03 is (mic, case) battery and 01/04 is
  // (mic, case) charging. They only refresh the status display.
  if (packet.type === 1 && (packet.id === 3 || packet.id === 4) && packet.payload.length >= 2) {
    this._emit('onDeviceStatus', packet.id === 3
      ? { micBattery: batteryPercent(packet.payload[0]), caseBattery: batteryPercent(packet.payload[1]) }
      : { micCharging: binaryFlag(packet.payload[0]), caseCharging: binaryFlag(packet.payload[1]) });
    return;
  }
  if (![26, 27].includes(packet.type)) return;
  if (this._watching && this.mode === null && packet.id === 6 && packet.status === 1 && packet.payload.length >= 4) {
    var pushed = u32(new Uint8Array(packet.payload), 0);
    if (pushed && pushed !== this._endedFile) this._detected(pushed, 'push');
    return;
  }
  if (this.mode === 'live' && this.state === 'waiting_for_recording' && packet.id === 6 && packet.status === 1 && packet.payload.length >= 4) {
    var active = u32(new Uint8Array(packet.payload), 0);
    if (active && active !== this._endedFile && !this._pending) {
      this._emit('onDiagnostic', { type: 'recording_detected', command: 'push' });
      this._beginTransfer(active).catch(this._fail.bind(this));
    }
    return;
  }
  if (this.currentFile === null || ![8, 18, 10].includes(packet.id)) return;
  if (packet.status !== 1) throw error('AUDIO_DEVICE_ERROR', 'Device rejected audio data');
  if (packet.id === 10) {
    if (this.state !== 'streaming') throw error('AUDIO_ORDER', 'File ended before a verified audio header');
    this._fileDone = true;
    // A kept link still needs its listener for status pushes and the next file.
    if (!this.options.keepAlive) { this._accepting = false; this._unlisten('offBLECharacteristicValueChange'); }
    return;
  }
  if (this._fileDone) throw error('AUDIO_ORDER', 'Audio arrived after the file end marker');
  if (this.state !== 'streaming') throw error('AUDIO_ORDER', 'Audio arrived before a verified audio header');
  var payload = new Uint8Array(packet.payload);
  if (!payload.length || payload.length % 166) throw error('AUDIO_SLICE_LENGTH', 'Audio notification must contain complete 166-byte slices');
  // A transfer ended without draining (a cancel) resets this state while a
  // slice may still be decrypting; that slice must not write into the next one.
  var serial = this._transferSerial;
  for (var offset = 0; offset < payload.length; offset += 166) {
    this._check(epoch); this._checkTransfer(serial);
    var sequence = u32(payload, offset);
    if (this.lastSequence !== null && sequence <= this.lastSequence) { this.stats.duplicates++; continue; }
    if (this.lastSequence !== null && sequence !== this.lastSequence + 1) {
      this.stats.sequenceGaps += sequence - this.lastSequence - 1;
      throw error('AUDIO_SEQUENCE_GAP', 'Audio sequence gap detected');
    }
    var frame = await this._crypto.decryptSlice(payload.subarray(offset, offset + 166)); this._check(epoch); this._checkTransfer(serial);
    frame.sourceType = this.mode === 'replay' ? 'device_recorded_file_replay' : 'live_device_recording';
    frame.receivedAtMs = item.receivedAtMs;
    await this._wait(this._emit('onFrame', frame), this.frameTimeoutMs, 'FRAME_DELIVERY_TIMEOUT'); this._check(epoch); this._checkTransfer(serial);
    this.lastSequence = sequence;
    if (this.stats.firstSequence === null) { this.stats.firstSequence = sequence; this._emit('onDiagnostic', { type: 'first_audio' }); }
    this.stats.lastSequence = sequence; this.stats.audioFrames++; this.stats.audioBytes += frame.opus.length;
  }
};
D3200Session.prototype._newTransfer = function (mode) {
  if (this.state !== 'crypto_ready' || this._closing) throw error('SESSION_STATE', 'Audio reading requires crypto_ready');
  // The page took up the noticed recording; watching resumes when it ends.
  if (this._rearmTimer) { this._clearTimer(this._rearmTimer); this._rearmTimer = null; }
  this.mode = mode; this._transfer = deferred(); this._lastEnd = null;
  return this._transfer.promise;
};
D3200Session.prototype.startLive = function (fileId) {
  this.unwatch();
  var promise = this._newTransfer('live');
  this._state('waiting_for_recording', { message: '请按录音豆上的实体录音键；页面不会控制录音。' });
  // A file already noticed while watching is read at once, without listing again.
  if (Number.isInteger(fileId) && fileId > 0 && fileId !== this._endedFile) this._beginTransfer(fileId).catch(this._fail.bind(this));
  else this._poll();
  return promise;
};
// With keepAlive, an idle link can watch for the physical key: it lists the
// active file on the watch interval and reports a new recording without
// reading it. A live read starts at the recorder's current position, not the
// file's start, so the page reads at once and opens its stream alongside.
D3200Session.prototype.watch = function () {
  if (!this.options.keepAlive || this._watching || this._closing || this._failure || this.state !== 'crypto_ready' || this.mode !== null) return false;
  // A file command owns the link; watching starts once the last one ends.
  if (this._managingCount) { this._resumeAfterManaging = true; return false; }
  this._watching = true; this._watchFailures = 0;
  this._watchPoll();
  return true;
};
// A recording was noticed while idle: negotiate its key right away, in
// parallel with the page opening its stream, then report it.
D3200Session.prototype._detected = function (fileId, via) {
  var self = this, serial = this._transferSerial;
  this.unwatch();
  this._emit('onDiagnostic', { type: 'recording_detected', command: via });
  this._prepared = null;
  this._preparing = this._exchangeSessionKey('audio_start', serial, true).then(function () {
    if (serial === self._transferSerial) self._prepared = { fileId: fileId, at: Date.now(), serial: serial };
  }, function () {}).finally(function () { self._preparing = null; });
  // The page may be unable to start (busy with another request). Without a
  // transfer the link watches again, so the recorder state stays current and
  // a recording still running is reported afresh.
  if (this._rearmTimer) this._clearTimer(this._rearmTimer);
  this._rearmTimer = this._timer(function () { self._rearmTimer = null; if (self.mode === null) self.watch(); }, this.preparedMs);
  this._emit('onRecordingDetected', { fileId: fileId });
};
D3200Session.prototype.unwatch = function () {
  this._watching = false;
  if (this._watchTimer) { this._clearTimer(this._watchTimer); this._watchTimer = null; }
};
D3200Session.prototype._watchPoll = async function () {
  var self = this;
  this._watchTimer = null;
  if (!this._watching || this._closing || this.state !== 'crypto_ready' || this.mode !== null || this._pending) {
    if (this._watching && this._pending) this._watchTimer = this._timer(function () { self._watchPoll(); }, this.watchIntervalMs);
    return;
  }
  try {
    var active = (await this._request(wire.listFiles(0), isFileList, fileListPage, this.listTimeoutMs)).active;
    if (!this._watching) return;
    // The phone's stop never stops the recorder. While idle, say whether it is
    // recording and whether that is a file the page no longer receives.
    var recorder = { recording: !!active, unreceived: !!active && active === this._endedFile };
    if (!this._recorder || this._recorder.recording !== recorder.recording || this._recorder.unreceived !== recorder.unreceived) {
      this._recorder = recorder; this._emit('onRecorderState', recorder);
    }
    this._watchFailures = 0;
    if (active && active !== this._endedFile) { this._detected(active, 'watch'); return; }
    this._watchTimer = this._timer(function () { self._watchPoll(); }, this.watchIntervalMs);
  } catch (failure) {
    if (failure.code === 'CANCELLED' || !this._watching) return;
    // The recorder can leave a listing unanswered while it starts a file, so
    // an unanswered one is asked again shortly; other failures back off. A
    // streak of WATCH_FAILURES means the link is gone, and reports only once.
    var busy = failure.code === 'DEVICE_ACK_TIMEOUT', streak = (this._watchFailures || 0) + 1;
    this._watchFailures = streak;
    if (streak === 1) this._emit('onDiagnostic', { type: 'watch_failed', code: failure.code });
    if (streak >= WATCH_FAILURES) {
      this.unwatch();
      this._fail(error('DEVICE_DISCONNECTED', 'The recorder stopped answering'));
      return;
    }
    var wait = busy ? this.watchIntervalMs : Math.min(this.watchIntervalMs * Math.pow(2, streak), 5000);
    this._watchTimer = this._timer(function () { self._watchPoll(); }, wait);
  }
};
// Managing the recorder's files shares the idle link with watching: watching
// pauses, each command waits for the one before it, then watching resumes.
D3200Session.prototype._managing = async function (work) {
  if (this._watching) this._resumeAfterManaging = true;
  this.unwatch();
  this._managingCount++;
  try { return await work(this); }
  finally {
    this._managingCount--;
    if (!this._managingCount && this._resumeAfterManaging) { this._resumeAfterManaging = false; this.watch(); }
  }
};
D3200Session.prototype._idle = async function () {
  var self = this;
  for (var waited = 0; this._pending && waited < 5000; waited += 30) await new Promise(function (resolve) { self._timer(resolve, 30); });
  if (this._closing || this._failure || this.state !== 'crypto_ready' || this.mode !== null) throw error('SESSION_STATE', 'Recorder files can only be managed on an idle link');
  if (this._pending) throw error('REQUEST_OVERLAP', 'The recorder is still answering another command');
};
// Every recording the recorder holds, oldest first. A short page ends the
// list; so does a page with nothing new, in case the recorder ignores paging.
D3200Session.prototype.listAllFiles = function () {
  return this._managing(async function (self) {
    var files = [], seen = {}, active = 0;
    for (var page = 0; page < 200; page++) {
      await self._idle();
      var result = await self._request(wire.listFiles(page), isFileList, fileListPage, self.listTimeoutMs);
      if (page === 0) active = result.active;
      var fresh = result.files.filter(function (file) { return !seen[file.fileId]; });
      fresh.forEach(function (file) { seen[file.fileId] = true; files.push(file); });
      if (result.files.length < FILE_PAGE || !fresh.length) break;
    }
    return { files: files, active: active };
  });
};
// One id per command, each answered or timed out before the next, as the
// vendor SDK does. The file being recorded is never sent.
D3200Session.prototype.deleteFiles = function (fileIds) {
  var ids = Array.isArray(fileIds) ? fileIds.slice() : [];
  if (!ids.length || ids.some(function (id) { return !Number.isInteger(id) || id < 1 || id > 0xffffffff; })) {
    return Promise.reject(error('CONFIGURATION', 'Explicit file IDs required'));
  }
  return this._managing(async function (self) {
    await self._idle();
    var active = (await self._request(wire.listFiles(0), isFileList, fileListPage, self.listTimeoutMs)).active;
    var deleted = [], failed = [];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === active) { failed.push(ids[i]); continue; }
      await self._idle();
      try {
        await self._request(wire.deleteFile(ids[i]), function (packet) { return [26, 27].includes(packet.type) && packet.id === 16; }, function () { return true; }, DELETE_TIMEOUT_MS);
        deleted.push(ids[i]);
      } catch (failure) {
        if (failure.code !== 'DEVICE_ACK_REJECTED' && failure.code !== 'DEVICE_ACK_TIMEOUT') throw failure;
        failed.push(ids[i]);
      }
    }
    self._emit('onDiagnostic', { type: 'files_deleted', code: deleted.length + '/' + ids.length });
    return { deleted: deleted.length, deletedIds: deleted, failed: failed };
  });
};
// Storage and battery as read at connection time, read again (after deleting).
D3200Session.prototype.readStatus = function () {
  return this._managing(async function (self) {
    await self._idle();
    return self._request(wire.readDeviceInfo(), function (packet) { return packet.type === 1 && packet.id === 1; }, function (packet) {
      if (packet.payload.length < 8) throw error('DEVICE_INFO_LAYOUT', 'Device information response is too short');
      return deviceStatus(packet.payload);
    });
  });
};
D3200Session.prototype.readFile = function (fileId) {
  wire.readAudio(fileId, 'replay'); // Validate before any state change or API call.
  var promise = this._newTransfer('replay');
  this._beginTransfer(fileId).catch(this._fail.bind(this));
  return promise;
};
D3200Session.prototype._poll = async function () {
  var self = this, epoch = this.epoch;
  if (this._closing || this.state !== 'waiting_for_recording') return;
  // A watch listing may still be awaiting its reply; take the next turn.
  if (this._pending) { this._pollTimer = this._timer(function () { self._pollTimer = null; self._poll(); }, 50); return; }
  try {
    var active = (await this._request(wire.listFiles(0), isFileList, fileListPage, this.listTimeoutMs)).active;
    this._check(epoch);
    if (this.state !== 'waiting_for_recording') return;
    if (active && active !== this._endedFile) { this._emit('onDiagnostic', { type: 'recording_detected', command: 'poll' }); await this._beginTransfer(active); return; }
    this._pollTimer = this._timer(function () { self._pollTimer = null; self._poll(); }, this.pollIntervalMs);
  } catch (failure) {
    // An unanswered listing while the recorder starts a file is retried, not fatal.
    if (failure.code === 'DEVICE_ACK_TIMEOUT' && !this._closing && this.state === 'waiting_for_recording') {
      this._emit('onDiagnostic', { type: 'poll_retry', code: failure.code });
      this._pollTimer = this._timer(function () { self._pollTimer = null; self._poll(); }, this.pollIntervalMs);
      return;
    }
    if (failure.code !== 'CANCELLED') this._fail(failure);
  }
};
D3200Session.prototype._beginTransfer = async function (fileId) {
  if (this._closing || this.currentFile !== null) return;
  if (this._pollTimer) { this._clearTimer(this._pollTimer); this._pollTimer = null; }
  this.currentFile = fileId;
  // Sequence checks and counts belong to this file alone.
  this.lastSequence = null; this.stats = freshStats();
  var self = this, epoch = this.epoch;
  // Waiting for the physical button can outlive the device's session key.
  // Establish a new verified exchange immediately before reading this file.
  // Keep the file-header marker check strict; never decode using a stale key.
  var serial = this._transferSerial;
  if (this._preparing) await this._preparing;
  this._check(epoch); this._checkTransfer(serial);
  var prepared = this._prepared;
  this._prepared = null;
  // Waiting for the key press can outlive the session key, so an exchange made
  // seconds ago for this very file is the only one reused.
  var reuse = prepared && prepared.fileId === fileId && prepared.serial === serial && Date.now() - prepared.at <= this.preparedMs;
  if (!reuse) { await this._exchangeSessionKey('audio_start', serial); this._check(epoch); this._checkTransfer(serial); }
  // A live read at offset 0 starts at the recorder's current position, so the
  // seconds before the page asked never arrive. With readFromStart, a
  // recording that has just started is asked for from its second slice (0
  // would mean "from now"), the way the vendor app resumes; a recorder that
  // refuses is read from now. Firmware 04.92 accepts the offset but still
  // sends from now (2026-11-03 device test), so it is off by default.
  var age = Date.now() / 1000 - fileId;
  var from = this.mode === 'live' && this.options.readFromStart === true && age > -120 && age < FRESH_SECONDS ? SLICE_BYTES : 0;
  this._emit('onDiagnostic', { type: 'audio_requested', command: reuse ? 'prepared_key' : 'fresh_key', phase: from ? 'from_start' : 'from_now' });
  this._state('requesting_audio', { fileId: fileId });
  function read(offset) {
    return self._request(wire.readAudio(fileId, self.mode, offset), function (packet) { return [26, 27].includes(packet.type) && packet.id === 7; }, async function (packet) {
      self._checkTransfer(serial);
      self._state('verifying_audio', { fileId: fileId });
      var result;
      try { result = await self._crypto.acceptAudioHeader(packet.payload, fileId); }
      catch (failure) { if (offset && failure.code === 'AUDIO_HEADER_REJECTED') return { refused: true }; throw failure; }
      self._check(epoch); self._checkTransfer(serial);
      self.reportedFileBytes = result.reportedFileBytes;
      self._state('streaming', { fileId: fileId, fileKeyVerified: true });
      return result;
    }).catch(function (failure) { if (offset && failure.code === 'DEVICE_ACK_REJECTED') return { refused: true }; throw failure; });
  }
  var header = await read(from);
  this._check(epoch); this._checkTransfer(serial);
  if (header.refused) {
    this._emit('onDiagnostic', { type: 'from_start_refused' });
    header = await read(0);
  }
  this._check(epoch);
  if (this._transfer) this._transfer.resolve(Object.assign({ sourceType: this.mode === 'replay' ? 'device_recorded_file_replay' : 'live_device_recording' }, header));
};
D3200Session.prototype.summary = function () {
  return Object.assign({ state: this.state, fileId: this.currentFile, sourceType: this.mode === 'replay' ? 'device_recorded_file_replay' : this.mode === 'live' ? 'live_device_recording' : null,
    reportedFileBytes: this.reportedFileBytes, deviceFileDone: this._fileDone, decoded: false }, this.stats);
};
D3200Session.prototype._complete = function () {
  var self = this;
  if (this._completion) return this._completion;
  if (!this.stats.audioFrames) { this._fail(error('EMPTY_AUDIO', 'File ended without a delivered audio packet')); return; }
  if (this.mode === 'replay' && this.stats.audioFrames * 166 !== this.reportedFileBytes) {
    this._fail(error('INCOMPLETE_REPLAY', 'Delivered replay size does not match the device file header')); return;
  }
  var kept = this.options.keepAlive && this.mode === 'live';
  this._completion = (kept ? this.endTransfer({ drain: true }) : this.stop({ drain: true })).then(function (result) {
    if (self._failure) return;
    if (!kept) self._state('completed');
    self._emit('onEnd', Object.assign({}, result, { reason: 'file_done', state: kept ? 'crypto_ready' : 'completed' }));
  }).catch(function (failure) { self._fail(failure); });
  return this._completion;
};
D3200Session.prototype._fail = function (failure) {
  if (this._failure || this._closing || (failure && failure.code === 'CANCELLED')) return;
  this._failure = failure instanceof Error ? failure : error('SESSION_FAILED', 'D3200 session failed');
  this._state('failed', { code: this._failure.code, message: this._failure.message });
  this._emit('onError', this._failure);
  this.disconnect().catch(function () {});
};
D3200Session.prototype.stop = function (options) {
  options = options || {};
  if (this._stopPromise) return this._stopPromise;
  var self = this, drain = options.drain === true;
  var timeout = bounded(options.timeoutMs, 15000, 1, 60000, 'drain timeout');
  this._accepting = false; this.unwatch();
  this._unlisten('offBLECharacteristicValueChange');
  if (this._pollTimer) { this._clearTimer(this._pollTimer); this._pollTimer = null; }
  this._stopPromise = (async function () {
    var drainFailure;
    if (drain && self.state === 'streaming') {
      try {
        await self._wait(self._pumpPromise, timeout, 'DRAIN_TIMEOUT');
        if (self._failure) throw self._failure;
        if (self._decoder.buffer.length) throw error('DRAIN_PARTIAL_FRAME', 'Reception ended with an incomplete BLE packet');
      }
      catch (failure) { drainFailure = failure; }
    }
    self._closing = true; self.epoch++;
    var cancellation = self._failure || error('CANCELLED', drain ? 'Reception stopped after draining' : 'Reception interrupted');
    if (self._pending) { self._pending.reject(cancellation); self._pending = null; }
    if (self._transfer) self._transfer.reject(cancellation);
    Array.from(self._operations).forEach(function (cancel) { cancel(cancellation); });
    self._timers.forEach(clearTimeout); self._timers.clear(); self._unlisten();
    self._queue = []; self._queuedBytes = 0; self._decoder = new wire.FrameDecoder();
    if (self._crypto) self._crypto.destroy();
    var cleanup = [];
    if (self._owners.scan === self) cleanup.push(await self._cleanupApi('stopBluetoothDevicesDiscovery', {}));
    if (self.deviceId && self._owners.devices.get(self.deviceId) === self) {
      if (self.connected && self._notifierId) cleanup.push(await self._cleanupApi('notifyBLECharacteristicValueChange', { deviceId: self.deviceId, serviceId: self._serviceId, characteristicId: self._notifierId, state: false }));
      cleanup.push(await self._cleanupApi('disconnectBLEDevice', { deviceId: self.deviceId }));
    }
    var disconnectResult = cleanup.find(function (item) { return item.api === 'disconnectBLEDevice'; });
    if (disconnectResult && disconnectResult.ok) self.connected = false;
    var cleanupComplete = cleanup.every(function (item) { return item.ok; });
    var result = Object.assign(self.summary(), { drained: drain && !drainFailure, interrupted: !drain || !!drainFailure,
      cleanup: cleanup, cleanupComplete: cleanupComplete, connectionClosed: !self.deviceId || !!(disconnectResult && disconnectResult.ok) });
    if (!self._failure) self._state(drainFailure ? 'failed' : 'stopped', { cleanupComplete: cleanupComplete, connectionClosed: result.connectionClosed });
    if (drainFailure) throw drainFailure;
    return result;
  })();
  return this._stopPromise;
};
// With keepAlive, a live recording ends without releasing the BLE link: queued
// audio drains, transfer state resets to crypto_ready, and the next startLive
// renegotiates the session key before reading a new file. The ended file is
// remembered so a recorder still writing it is never read twice.
D3200Session.prototype.endTransfer = function (options) {
  options = options || {};
  if (!this.options.keepAlive) return this.stop(options);
  if (this._endPromise) return this._endPromise;
  if (this._closing || this._failure) return Promise.reject(this._failure || error('SESSION_STATE', 'Session is already closed'));
  if (this.mode === null && this.state === 'crypto_ready') return Promise.resolve(this._lastEnd || Object.assign(this.summary(), { connectionClosed: false, connectionKept: true }));
  var self = this, drain = options.drain === true;
  var timeout = bounded(options.timeoutMs, 15000, 1, 60000, 'drain timeout');
  if (this._pollTimer) { this._clearTimer(this._pollTimer); this._pollTimer = null; }
  this._ending = true;
  this._endPromise = (async function () {
    var discarded = 0;
    if (drain && self.state === 'streaming') {
      try {
        await self._wait(self._pumpPromise, timeout, 'DRAIN_TIMEOUT');
        if (self._failure) throw self._failure;
        // After the file-end marker nothing may be left half-received. A phone
        // stop ends while the recorder keeps streaming, so the packet still
        // arriving belongs to audio this recording no longer takes.
        if (self._decoder.buffer.length && self._fileDone) throw error('DRAIN_PARTIAL_FRAME', 'Reception ended with an incomplete BLE packet');
        discarded = self._decoder.buffer.length;
      } catch (failure) {
        // A recording that cannot end cleanly fails (reported once, so whoever
        // receives it is never left waiting) and releases the link.
        self._endPromise = null; self._ending = false;
        self._fail(failure);
        await self.stop({ drain: false }).catch(function () {});
        throw failure;
      }
    }
    // Requests still in flight (a file-list poll, a key exchange or an audio
    // header) belong to the ended recording; cancel them, keep the link.
    var cancellation = error('CANCELLED', 'Recording ended');
    self._transferSerial++; self._prepared = null;
    if (self._pending) { self._pending.reject(cancellation); self._pending = null; }
    Array.from(self._operations).forEach(function (cancel) { cancel(cancellation); });
    var result = Object.assign(self.summary(), { drained: drain, interrupted: !drain, connectionClosed: false, connectionKept: true,
      discardedPartialBytes: discarded });
    if (discarded) self._emit('onDiagnostic', { type: 'partial_packet_discarded', code: String(discarded) });
    if (self.currentFile !== null) self._endedFile = self.currentFile;
    self._transfer = null; self._completion = null; self._fileDone = false;
    self.mode = null; self.currentFile = null; self.lastSequence = null; self.reportedFileBytes = undefined;
    self._queue = []; self._queuedBytes = 0; self._decoder = new wire.FrameDecoder();
    self.stats = freshStats();
    self._lastEnd = result; self._ending = false; self._endPromise = null;
    self._state('crypto_ready', { transferEnded: true, message: '本段已结束，录音豆保持连接' });
    return result;
  })();
  return this._endPromise;
};
D3200Session.prototype.finish = function (options) { return this.stop(Object.assign({}, options, { drain: true })); };
D3200Session.prototype.drain = D3200Session.prototype.finish;
D3200Session.prototype.disconnect = function () {
  var self = this;
  if (this._stopPromise && !this._closing) {
    // An explicit cancellation interrupts an in-progress drain, including a hung consumer.
    var cancelled = error('CANCELLED', 'Reception interrupted during drain');
    Array.from(this._operations).forEach(function (cancel) { cancel(cancelled); });
    return this._stopPromise.catch(function (failure) {
      if (failure.code !== 'CANCELLED') throw failure;
      return Object.assign(self.summary(), { drained: false, interrupted: true });
    });
  }
  return this.stop({ drain: false });
};
D3200Session.prototype.cancel = D3200Session.prototype.disconnect;
module.exports = D3200Session;
