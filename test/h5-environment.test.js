'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const environment = require('../h5/environment');

test('an ordinary browser is not reported as an authenticated Feishu session', () => {
  const result = environment.inspect({ WebSocket() {} });
  assert.equal(result.sdkLoaded, false);
  assert.equal(result.jsapiAuthenticated, false);
  assert.equal(result.deviceConnected, false);
  assert.deepEqual(result.declaredBleMethods, []);
});

test('method presence never invokes hardware APIs or proves authorization', () => {
  let calls = 0;
  const result = environment.inspect({
    h5sdk: { config() { calls++; }, ready() { calls++; } },
    tt: { openBluetoothAdapter() { calls++; }, connectBLEDevice: true },
    WebSocket() { calls++; }
  });
  assert.equal(calls, 0);
  assert.equal(result.sdkLoaded, true);
  assert.deepEqual(result.declaredBleMethods, ['openBluetoothAdapter']);
  assert.equal(result.jsapiAuthenticated, false);
  assert.equal(result.realtimeAsrVerified, false);
});

test('diagnostic results exclude credentials and private SDK data', () => {
  const result = environment.inspect({
    h5sdk: { config() {}, ready() {}, secret: 'do-not-return' },
    tt: { ticket: 'do-not-return' }
  });
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
});
