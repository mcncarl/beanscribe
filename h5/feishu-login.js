(function () {
  'use strict';
  var config = JSON.parse(document.getElementById('login-config').textContent);
  var status = document.getElementById('login-status');
  var retry = document.getElementById('login-retry');
  var finished = false;
  var submitted = false;
  var requesting = false;
  var legacyRequested = false;
  var deadline = setTimeout(function () { fail('连接飞书超时，请重新打开应用。'); }, 25000);

  function fail(message) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    status.textContent = message;
    retry.hidden = false;
  }
  retry.addEventListener('click', function () { location.reload(); });
  function nativeFailure(error) {
    var code = error && (error.errno || error.errCode);
    var detail = Number.isInteger(code) ? '（代码 ' + code + '）' : '';
    fail('飞书登录失败' + detail + '，请重新打开应用。');
  }

  async function exchange(result) {
    if (submitted || finished) return;
    if (!result || typeof result.code !== 'string' || !result.code ||
        (result.state !== undefined && result.state !== config.state)) {
      fail('未取得有效的飞书身份，请重新打开应用。');
      return;
    }
    submitted = true;
    try {
      var response = await fetch(config.base + '/api/feishu-session', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: result.code, state: config.state })
      });
      if (finished) return;
      if (!response.ok) {
        fail(response.status === 403 ? '此应用仅供本人使用，请切换到已授权的飞书账号。' :
          '飞书登录暂未完成，请重新打开应用。');
        return;
      }
      finished = true;
      clearTimeout(deadline);
      location.replace(config.destination);
    } catch (_) { fail('网络连接失败，请重新打开应用。'); }
  }
  function legacy() {
    if (finished || legacyRequested) return;
    legacyRequested = true;
    if (!window.tt || typeof window.tt.requestAuthCode !== 'function') {
      fail('请在飞书内打开“录音豆”。');
      return;
    }
    window.tt.requestAuthCode({ appId: config.appId, success: exchange, fail: nativeFailure });
  }
  function start() {
    if (requesting || finished) return;
    requesting = true;
    try {
      if (window.tt && typeof window.tt.requestAccess === 'function') {
        window.tt.requestAccess({ appID: config.appId, scopeList: [], state: config.state,
          success: exchange, fail: function (error) {
            if (error && error.errno === 103) legacy();
            else nativeFailure(error);
          } });
      } else { legacy(); }
    } catch (_) { fail('无法连接飞书，请重新打开应用。'); }
  }
  // Loading the official SDK does not start BLE or recording, or request any
  // additional API permissions. requestAccess is exempt from JSAPI signing.
  var sdk = document.createElement('script');
  sdk.src = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.16.js';
  sdk.referrerPolicy = 'no-referrer';
  sdk.onload = function () {
    if (window.h5sdk && typeof window.h5sdk.ready === 'function') window.h5sdk.ready(start);
    else start();
  };
  sdk.onerror = function () { fail('飞书组件加载失败，请重新打开应用。'); };
  document.head.appendChild(sdk);
}());
