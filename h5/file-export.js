(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MinutesFileExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  async function download(blob, name, environment) {
    var scope = environment || globalThis;
    var nav = scope.navigator || {};
    var ios = /iPhone|iPad|iPod/.test(nav.userAgent || '') ||
      (/Macintosh/.test(nav.userAgent || '') && nav.maxTouchPoints > 1);
    if (ios) {
      if (!scope.File || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
        throw new Error('当前页面不能打开系统文件菜单，请在电脑端下载。');
      }
      var file = new scope.File([blob], name, { type: blob.type || 'application/octet-stream' });
      var data = { files: [file] };
      if (!nav.canShare(data)) throw new Error('系统暂不支持导出此文件类型，请在电脑端下载。');
      if (nav.userActivation && !nav.userActivation.isActive) {
        throw new Error('文件已准备好，请再次点击导出，在系统菜单选择“存储到文件”。');
      }
      try {
        await nav.share(data);
        return { method: 'system', cancelled: false };
      } catch (error) {
        if (error && error.name === 'AbortError') return { method: 'system', cancelled: true };
        if (error && error.name === 'NotAllowedError') {
          throw new Error('系统未打开文件菜单，请再次点击导出。');
        }
        throw error;
      }
    }
    var url = scope.URL.createObjectURL(blob);
    var link = scope.document.createElement('a');
    link.href = url;
    link.download = name;
    scope.document.body.append(link);
    try { link.click(); } finally {
      link.remove();
      scope.setTimeout(function () { scope.URL.revokeObjectURL(url); }, 60000);
    }
    return { method: 'browser', cancelled: false };
  }

  return { download: download };
});
