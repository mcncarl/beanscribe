'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../h5/feishu-login.js'), 'utf8');

function harness(tt, fetchResult = { ok: true, status: 200 }) {
  const config = { appId: 'cli_test', base: '/minutes', state: 'nonce-state',
    destination: '/minutes/preview.html?recording=saved-one' };
  const elements = {
    'login-config': { textContent: JSON.stringify(config) },
    'login-status': { textContent: '' },
    'login-retry': { hidden: true, addEventListener(_name, callback) { this.click = callback; } }
  };
  const calls = [], locations = [], timers = [];
  let script, ready;
  const root = { tt, h5sdk: { ready(callback) { ready = callback; } } };
  const context = { window: root, document: {
    getElementById(id) { return elements[id]; },
    createElement() { return {}; },
    head: { appendChild(value) { script = value; } }
  }, location: { replace(url) { locations.push(url); }, reload() { locations.push('reload'); } },
  setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {},
  fetch: async (...args) => { calls.push(args); return fetchResult; } };
  vm.runInNewContext(source, context);
  script.onload();
  return { config, elements, calls, locations, timers, script, start: () => ready() };
}

test('native login starts automatically with no extra scopes and no recording API', async () => {
  let request;
  const h = harness({ requestAccess(value) { request = value; } });
  h.start(); h.start();
  assert.equal(request.appID, 'cli_test');
  assert.equal(JSON.stringify(request.scopeList), '[]');
  assert.equal(request.state, h.config.state);
  await request.success({ code: 'one-use-code', state: h.config.state });
  await request.success({ code: 'duplicate-callback', state: h.config.state });
  assert.equal(h.calls.length, 1);
  const [url, options] = h.calls[0];
  assert.equal(url, '/minutes/api/feishu-session');
  assert.deepEqual(JSON.parse(options.body), { code: 'one-use-code', state: 'nonce-state' });
  assert.deepEqual(h.locations, ['/minutes/preview.html?recording=saved-one']);
});

test('old client uses requestAuthCode only for explicit unsupported API result', async () => {
  let access, legacy;
  const h = harness({ requestAccess(value) { access = value; }, requestAuthCode(value) { legacy = value; } });
  h.start();
  access.fail({ errno: 103 });
  assert.equal(legacy.appId, h.config.appId);
  await legacy.success({ code: 'legacy-code' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.locations.length, 1);
});

test('permission denial never falls back or silently retries', () => {
  let access;
  const h = harness({ requestAccess(value) { access = value; }, requestAuthCode() { throw Error('unexpected fallback'); } });
  h.start();
  access.fail({ errno: 105, errString: 'untrusted secret error' });
  assert.equal(h.elements['login-retry'].hidden, false);
  assert.equal(h.calls.length, 0);
  assert.ok(!h.elements['login-status'].textContent.includes('untrusted'));
});

test('invalid or mismatched callback cannot create a session', async () => {
  let access;
  const h = harness({ requestAccess(value) { access = value; } });
  h.start();
  await access.success({ code: 'code', state: 'another-state' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.locations.length, 0);
  assert.equal(h.elements['login-retry'].hidden, false);
});

test('owner mismatch shows a useful error and never opens saved recordings', async () => {
  let access;
  const h = harness({ requestAccess(value) { access = value; } }, { ok: false, status: 403 });
  h.start();
  await access.success({ code: 'code' });
  assert.equal(h.locations.length, 0);
  assert.match(h.elements['login-status'].textContent, /仅供本人/);
  h.elements['login-retry'].click();
  assert.deepEqual(h.locations, ['reload']);
});

test('a late callback after timeout cannot submit a code or navigate', async () => {
  let access;
  const h = harness({ requestAccess(value) { access = value; } });
  h.start();
  h.timers[0]();
  await access.success({ code: 'late-code' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.locations.length, 0);
});

test('outside Feishu shows an app-opening hint with no password form', () => {
  const h = harness({});
  h.start();
  assert.match(h.elements['login-status'].textContent, /请在飞书内打开/);
  assert.equal(h.calls.length, 0);
});
