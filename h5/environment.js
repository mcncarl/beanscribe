(function (root) {
  'use strict';
  var SDK_URL = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.16.js';
  var BLE_METHODS = [
    'openBluetoothAdapter', 'connectBLEDevice', 'getBLEDeviceServices',
    'getBLEDeviceCharacteristics', 'notifyBLECharacteristicValueChange',
    'writeBLECharacteristicValue', 'onBLECharacteristicValueChange'
  ];

  // Method presence does not establish JSAPI authorization or device support.
  function inspect(environment) {
    var sdk = environment.h5sdk;
    var bridge = environment.tt || {};
    var names = BLE_METHODS.filter(function (name) { return typeof bridge[name] === 'function'; });
    return {
      sdkLoaded: Boolean(sdk && typeof sdk.config === 'function' && typeof sdk.ready === 'function'),
      declaredBleMethods: names,
      browserWebSocketPresent: typeof environment.WebSocket === 'function',
      jsapiAuthenticated: false,
      deviceConnected: false,
      realtimeAsrVerified: false
    };
  }

  var api = { SDK_URL: SDK_URL, inspect: inspect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FeishuEnvironment = api;
}(typeof window !== 'undefined' ? window : this));
