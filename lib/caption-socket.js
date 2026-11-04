/* Optional receiver for the custom gateway contract. No endpoint or token ships
 * in this project. The demo never constructs or connects this class.
 */
function CaptionSocket(ttApi, options) {
  this.api = ttApi;
  this.options = options || {};
  this.task = null;
  this.status = 'idle';
  this.timeout = null;
  this.generation = 0;
}

CaptionSocket.prototype.setStatus = function (status) {
  this.status = status;
  if (this.options.onStatus) this.options.onStatus(status);
};

CaptionSocket.prototype.connect = function () {
  if (this.task) throw new Error('Connection already exists');
  var options = this.options;
  if (!this.api || typeof this.api.connectSocket !== 'function') throw new Error('Socket API unavailable');
  // Avoid tokens in query strings, implicit public endpoints, and raw provider keys.
  if (typeof options.gatewayHost !== 'string' || !/^[a-z0-9.-]+$/i.test(options.gatewayHost) ||
      options.url !== 'wss://' + options.gatewayHost + '/captions' ||
      typeof options.sessionToken !== 'string' || options.sessionToken.length < 16 ||
      /[\r\n]/.test(options.sessionToken)) throw new Error('An explicit WSS gateway and short-lived session token are required');
  var self = this;
  var generation = ++this.generation;
  var isCurrent = function () { return generation === self.generation; };
  this.setStatus('connecting');
  var task;
  try {
    task = this.api.connectSocket({
      url: options.url,
      header: { Authorization: 'Bearer ' + options.sessionToken },
      fail: function () { if (isCurrent()) self.disconnect('failed'); }
    });
  } catch (_) {
    this.disconnect('failed');
    throw new Error('Feishu socket creation failed');
  }
  if (!isCurrent()) {
    if (task && typeof task.close === 'function') task.close({ code: 1000, reason: 'cancelled' });
    return;
  }
  this.task = task;
  if (!task || !['onOpen', 'onMessage', 'onClose', 'close'].every(function (name) { return typeof task[name] === 'function'; })) {
    this.disconnect('failed');
    throw new Error('Invalid Feishu SocketTask');
  }
  this.timeout = setTimeout(function () { if (isCurrent()) self.disconnect('timeout'); }, 10000);
  task.onOpen(function () {
    if (!isCurrent()) return;
    clearTimeout(self.timeout);
    self.timeout = null;
    self.setStatus('connected');
  });
  task.onMessage(function (message) {
    if (!isCurrent() || self.status !== 'connected') return;
    try {
      if (!message || typeof message.data !== 'string' || message.data.length > 16384) throw new Error('Invalid gateway payload');
      var event = JSON.parse(message.data);
      if (!event || !['transcript', 'translation'].includes(event.type)) throw new Error('Unexpected event');
      // The supplied reducer performs full schema and revision validation.
      if (options.onEvent) options.onEvent(event);
    } catch (_) {
      self.disconnect('invalid_message');
    }
  });
  task.onClose(function (event) {
    if (!isCurrent()) return;
    clearTimeout(self.timeout);
    self.timeout = null;
    self.task = null;
    self.generation++;
    self.setStatus(event && String(event.closeType) === '2' ? 'background' : 'closed');
  });
};

CaptionSocket.prototype.disconnect = function (reason) {
  this.generation++;
  clearTimeout(this.timeout);
  this.timeout = null;
  var task = this.task;
  this.task = null;
  this.setStatus(reason || 'closed');
  if (task && typeof task.close === 'function') task.close({ code: 1000, reason: 'client stopped' });
};

module.exports = CaptionSocket;
