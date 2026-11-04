'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { File } = require('node:buffer');
const exporter = require('../h5/file-export');

function iphone(share, extra = {}) {
  return {
    navigator: { userAgent: 'iPhone', canShare: () => true, share, ...extra }, File,
    document: { createElement() { throw new Error('iPhone export must not navigate to a blob URL'); } }
  };
}

test('iPhone exports a named file through the system sheet and waits for completion', async () => {
  let finish, submitted, completed = false;
  const scope = iphone(data => { submitted = data; return new Promise(resolve => { finish = resolve; }); });
  const pending = exporter.download(new Blob(['原文'], { type: 'text/plain' }), '录音.txt', scope).then(result => { completed = true; return result; });
  assert.equal(submitted.files[0].name, '录音.txt');
  assert.equal(await submitted.files[0].text(), '原文');
  assert.equal(completed, false);
  finish();
  assert.deepEqual(await pending, { method: 'system', cancelled: false });
});

test('cancelling the iPhone sheet neither navigates nor claims an export', async () => {
  const scope = iphone(async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; });
  assert.deepEqual(await exporter.download(new Blob(['x']), 'record.srt', scope), { method: 'system', cancelled: true });
});

test('unsupported file types and expired gestures keep the page in place', async () => {
  let calls = 0;
  await assert.rejects(exporter.download(new Blob(['x']), 'record.srt', iphone(() => { calls++; }, { canShare: () => false })), /不支持/);
  await assert.rejects(exporter.download(new Blob(['x']), 'record.wav', iphone(() => { calls++; }, { userActivation: { isActive: false } })), /再次点击/);
  assert.equal(calls, 0);
});

test('iPad desktop user agent still selects system file export', async () => {
  let calls = 0;
  const scope = iphone(async () => { calls++; }, { userAgent: 'Macintosh', maxTouchPoints: 5 });
  assert.equal((await exporter.download(new Blob(['wave']), 'record.wav', scope)).method, 'system');
  assert.equal(calls, 1);
});

test('desktop browsers keep named downloads and release the temporary URL', async () => {
  let clicked = false, removed = false, revoked = '', deferred;
  const link = { click() { clicked = true; }, remove() { removed = true; } };
  const scope = {
    navigator: { userAgent: 'Macintosh', maxTouchPoints: 0 },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL(value) { revoked = value; } },
    document: { createElement: () => link, body: { append() {} } },
    setTimeout(fn) { deferred = fn; }
  };
  assert.equal((await exporter.download(new Blob(['x']), 'record.txt', scope)).method, 'browser');
  assert.equal(link.download, 'record.txt'); assert.ok(clicked && removed);
  assert.equal(revoked, ''); deferred(); assert.equal(revoked, 'blob:test');
});
