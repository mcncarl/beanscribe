/* Native Feishu mini-app transport only. tt.connectSocket is NOT an H5 API.
 * Constructing/importing is inert; only start(auth) opens a connection.
 * No credential, audio or response is persisted or logged by this module.
 */
var binary = require('./binary');
var protocol = require('./volc-protocol');

function failure(code, message, providerCode) {
  var error = new Error(message);
  error.code = code;
  if (providerCode !== undefined) error.providerCode = providerCode;
  return error;
}

function VolcAsrClient(ttApi, options) {
  this.api = ttApi;
  this.options = options || {};
  this.clock = this.options.clock || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  this.status = 'idle';
  this.task = null;
  this.generation = 0;
  this.ended = false;
  this.timers = {};
  this.queue = [];
  this.queuedBytes = 0;
  this.activeJob = null;
  this.nextSequence = 1;
  this.ready = false;
  this.configSent = false;
  this.configAcknowledged = false;
  this.finishing = false;
  this.finalSent = false;
  this.finalResponse = null;
  this.hasFinalText = false;
  this.startResolve = this.startReject = null;
  this.finishResolve = this.finishReject = null;
  this.compression = 'gzip';
}

VolcAsrClient.prototype.setStatus = function (status) {
  this.status = status;
  if (this.options.onStatus) {
    try { this.options.onStatus(status); } catch (_) { /* observer must not interrupt cleanup */ }
  }
};

VolcAsrClient.prototype.clearTimer = function (name) {
  if (this.timers[name] !== undefined) this.clock.clearTimeout(this.timers[name]);
  delete this.timers[name];
};

VolcAsrClient.prototype.setTimer = function (name, milliseconds, callback) {
  this.clearTimer(name);
  var self = this, generation = this.generation;
  this.timers[name] = this.clock.setTimeout(function () {
    delete self.timers[name];
    if (!self.ended && self.generation === generation) callback();
  }, milliseconds);
};

VolcAsrClient.prototype.clearTimers = function () {
  var self = this;
  Object.keys(this.timers).forEach(function (name) { self.clearTimer(name); });
};

VolcAsrClient.prototype.stopTransport = function () {
  this.generation++;
  this.clearTimers();
  var task = this.task;
  this.task = null;
  if (task && typeof task.close === 'function') {
    try { task.close({ code: 1000, reason: 'client session ended' }); } catch (_) { /* already closed */ }
  }
};

VolcAsrClient.prototype.fail = function (error, status) {
  if (this.ended) return;
  this.ended = true;
  this.ready = false;
  this.stopTransport();
  if (this.startReject) this.startReject(error);
  if (this.finishReject) this.finishReject(error);
  this.startResolve = this.startReject = this.finishResolve = this.finishReject = null;
  if (this.activeJob) this.activeJob.reject(error);
  this.activeJob = null;
  this.queue.forEach(function (job) { job.reject(error); });
  this.queue = [];
  this.queuedBytes = 0;
  this.setStatus(status || 'failed');
  if (this.options.onError) {
    try { this.options.onError(error); } catch (_) { /* state and promises already settled */ }
  }
};

VolcAsrClient.prototype.tryReady = function () {
  if (this.ended || this.ready || !this.configSent || !this.configAcknowledged) return;
  this.clearTimer('start');
  this.ready = true;
  this.setStatus('streaming');
  var resolve = this.startResolve;
  this.startResolve = this.startReject = null;
  if (resolve) resolve();
};

VolcAsrClient.prototype.tryComplete = function () {
  if (this.ended || !this.finalResponse || !this.finalSent || this.activeJob || this.queue.length) return;
  if (!this.hasFinalText) { this.fail(failure('NO_FINAL_TEXT', 'ASR finished without confirmed text')); return; }
  this.ended = true;
  this.ready = false;
  this.stopTransport();
  this.setStatus('completed');
  var resolve = this.finishResolve;
  this.finishResolve = this.finishReject = null;
  if (resolve) resolve(this.finalResponse);
};

VolcAsrClient.prototype.enqueue = function (frame, kind) {
  var self = this;
  if (this.ended) return Promise.reject(failure('CLOSED', 'ASR session has ended'));
  if (this.queuedBytes + frame.length > 512 * 1024 || this.queue.length >= 128) {
    var error = failure('BACKPRESSURE', 'ASR send queue limit exceeded');
    this.fail(error);
    return Promise.reject(error);
  }
  return new Promise(function (resolve, reject) {
    self.queue.push({ frame: frame, kind: kind, resolve: resolve, reject: reject });
    self.queuedBytes += frame.length;
    self.pump();
  });
};

VolcAsrClient.prototype.pump = function () {
  if (this.ended || this.activeJob || !this.task || !this.queue.length) return;
  var self = this, generation = this.generation;
  var job = this.activeJob = this.queue.shift();
  this.setTimer('send', 10000, function () { self.fail(failure('SEND_TIMEOUT', 'Feishu did not acknowledge the audio send')); });
  try {
    this.task.send({
      data: binary.arrayBuffer(job.frame),
      success: function () {
        if (self.ended || generation !== self.generation || self.activeJob !== job) return;
        self.clearTimer('send');
        self.activeJob = null;
        self.queuedBytes -= job.frame.length;
        if (job.kind === 'config') { self.configSent = true; self.tryReady(); }
        if (job.kind === 'last') {
          self.finalSent = true;
          self.setStatus('awaiting_final');
          self.setTimer('final', 10000, function () { self.fail(failure('FINAL_TIMEOUT', 'ASR did not return a final package')); });
        }
        job.resolve();
        self.pump();
        self.tryComplete();
      },
      fail: function () {
        if (!self.ended && generation === self.generation) self.fail(failure('SEND_FAILED', 'Feishu rejected the audio send'));
      }
    });
  } catch (_) { this.fail(failure('SEND_FAILED', 'Feishu audio send threw an error')); }
};

VolcAsrClient.prototype.start = function (auth) {
  if (this.status !== 'idle') throw new Error('Use a new client for each ASR session');
  if (!this.api || typeof this.api.connectSocket !== 'function') throw new Error('Native Feishu Socket API unavailable');
  if (!auth || typeof auth.apiKey !== 'string' || !auth.apiKey.trim() || /[\r\n]/.test(auth.apiKey) ||
      typeof auth.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(auth.requestId)) {
    throw new Error('Runtime API credential and UUID request ID are required');
  }
  var request = protocol.createOggRequest({ codecMode: auth.codecMode });
  this.compression = auth.compression === undefined ? 'gzip' : auth.compression;
  var configFrame = protocol.encodeFullRequest(request, 1, this.compression);
  this.nextSequence = 2;
  var self = this, generation = ++this.generation;
  var promise = new Promise(function (resolve, reject) { self.startResolve = resolve; self.startReject = reject; });
  this.setStatus('connecting');
  this.setTimer('start', 15000, function () { self.fail(failure('START_TIMEOUT', 'ASR handshake or configuration timed out')); });
  this.setTimer('session', 60000, function () { self.fail(failure('SESSION_LIMIT', 'Prototype session time limit reached')); });
  var task;
  try {
    // The credential is only used here. It is not copied onto the client,
    // into request payloads, logs, storage, URLs, or the rendered page.
    task = this.api.connectSocket({
      url: protocol.ENDPOINT,
      header: { 'X-Api-Key': auth.apiKey, 'X-Api-Resource-Id': protocol.RESOURCE_ID, 'X-Api-Request-Id': auth.requestId },
      fail: function () { if (!self.ended && generation === self.generation) self.fail(failure('CONNECT_FAILED', 'Feishu could not create the ASR connection')); }
    });
  } catch (_) { this.fail(failure('CONNECT_FAILED', 'Feishu could not create the ASR connection')); }
  if (this.ended) {
    if (task && typeof task.close === 'function') task.close({ code: 1000, reason: 'cancelled' });
    return promise;
  }
  this.task = task;
  if (!task || !['onOpen', 'onMessage', 'onClose', 'send', 'close'].every(function (method) { return typeof task[method] === 'function'; })) {
    this.fail(failure('INVALID_SOCKET', 'Feishu returned an invalid SocketTask'));
    return promise;
  }
  task.onOpen(function () {
    if (self.ended || generation !== self.generation || self.status !== 'connecting') return;
    self.setStatus('configuring');
    self.enqueue(configFrame, 'config').catch(function () { /* fail already settles start */ });
  });
  task.onMessage(function (message) {
    if (self.ended || generation !== self.generation) return;
    var response;
    try { response = protocol.decodeServerMessage(message.data); }
    catch (_) { self.fail(failure('INVALID_RESPONSE', 'ASR returned malformed binary data')); return; }
    if (response.type === 'error') {
      self.fail(failure('PROVIDER_ERROR', 'Volcengine returned an ASR error', response.code));
      return;
    }
    if (response.final && !self.finishing) {
      self.fail(failure('EARLY_FINAL', 'ASR ended before the client finished audio'));
      return;
    }
    self.configAcknowledged = true;
    self.tryReady();
    var result = response.payload && response.payload.result;
    var results = Array.isArray(result) ? result : result ? [result] : [];
    results.forEach(function (item) {
      if (response.final && typeof item.text === 'string' && item.text.trim()) self.hasFinalText = true;
      if (Array.isArray(item.utterances) && item.utterances.some(function (utterance) {
        return utterance.definite === true && typeof utterance.text === 'string' && utterance.text.trim();
      })) self.hasFinalText = true;
    });
    if (self.options.onResult) {
      try { self.options.onResult(response); }
      catch (_) { self.fail(failure('CALLBACK_ERROR', 'ASR result handler failed')); return; }
    }
    if (response.final) { self.finalResponse = response; self.tryComplete(); }
  });
  task.onClose(function (event) {
    if (self.ended || generation !== self.generation) return;
    var background = event && String(event.closeType) === '2';
    self.fail(failure(background ? 'BACKGROUND' : 'CONNECTION_CLOSED', background ? 'Feishu moved the app to the background' : 'ASR connection closed before completion'), background ? 'background' : 'failed');
  });
  return promise;
};

VolcAsrClient.prototype.sendAudio = function (value) {
  if (!this.ready || this.ended || this.finishing) return Promise.reject(failure('NOT_STREAMING', 'ASR is not accepting audio'));
  var data = binary.bytes(value);
  if (!data.length || data.length > 64 * 1024) return Promise.reject(failure('AUDIO_CHUNK_SIZE', 'Audio chunk must contain 1 to 65536 bytes'));
  var frame = protocol.encodeAudio(data, this.nextSequence, false, this.compression);
  this.nextSequence++;
  return this.enqueue(frame, 'audio');
};

VolcAsrClient.prototype.finish = function (value) {
  if (!this.ready || this.ended || this.finishing) return Promise.reject(failure('NOT_STREAMING', 'ASR cannot finish in the current state'));
  var data = binary.bytes(value);
  if (!data.length || data.length > 64 * 1024) return Promise.reject(failure('AUDIO_CHUNK_SIZE', 'Supply the final Ogg EOS bytes'));
  var frame = protocol.encodeAudio(data, this.nextSequence, true, this.compression);
  this.nextSequence++;
  this.finishing = true;
  this.setStatus('draining');
  var self = this;
  var promise = new Promise(function (resolve, reject) { self.finishResolve = resolve; self.finishReject = reject; });
  this.enqueue(frame, 'last').catch(function () { /* fail already settles finish */ });
  return promise;
};

VolcAsrClient.prototype.cancel = function (background) {
  this.fail(failure(background ? 'BACKGROUND' : 'CANCELLED', background ? 'App hidden; ASR session cancelled' : 'ASR session cancelled'), background ? 'background' : 'cancelled');
};

module.exports = VolcAsrClient;
