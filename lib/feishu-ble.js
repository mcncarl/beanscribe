/* Narrow adapter, intentionally not connected to the demo page.
 * The caller must explicitly select, connect and discover the device first.
 * No automatic scan, pairing, read, retry, or command fragmentation is provided.
 */
var protocol = require('./ble-frame');
var SERVICE = '020cf5da-0000-1000-8000-00805f9b34fb';
var WRITER = '00007777-0000-1000-8000-00805f9b34fb';
var NOTIFIER = '00008888-0000-1000-8000-00805f9b34fb';

function normalizeUuid(value) {
  var uuid = String(value || '').toLowerCase();
  if (/^[0-9a-f]{4}$/.test(uuid)) uuid = '0000' + uuid;
  if (/^[0-9a-f]{8}$/.test(uuid)) uuid += '-0000-1000-8000-00805f9b34fb';
  return uuid;
}

function apiAvailability(ttApi) {
  var names = ['openBluetoothAdapter', 'connectBLEDevice', 'getBLEDeviceServices',
    'getBLEDeviceCharacteristics', 'notifyBLECharacteristicValueChange',
    'onBLECharacteristicValueChange', 'offBLECharacteristicValueChange',
    'writeBLECharacteristicValue', 'disconnectBLEDevice', 'connectSocket'];
  return names.map(function (name) { return { name: name, available: !!ttApi && typeof ttApi[name] === 'function' }; });
}

function targetChecked(target) {
  if (!target || typeof target.deviceId !== 'string' || !target.deviceId.trim() ||
      typeof target.serviceId !== 'string' || normalizeUuid(target.serviceId) !== SERVICE ||
      typeof target.characteristicId !== 'string' || normalizeUuid(target.characteristicId) !== WRITER) {
    throw new Error('An explicitly selected D3200 write target is required');
  }
  return { deviceId: target.deviceId, serviceId: target.serviceId, characteristicId: target.characteristicId };
}

function writeFrame(ttApi, target, frame) {
  // Complete all validation before invoking any platform API.
  var value = protocol.prepareWrite(frame);
  var selected = targetChecked(target);
  if (!ttApi || typeof ttApi.writeBLECharacteristicValue !== 'function') throw new Error('BLE write API unavailable');
  return new Promise(function (resolve, reject) {
    ttApi.writeBLECharacteristicValue(Object.assign({}, selected, {
      value: value,
      success: resolve,
      fail: function (error) {
        var failure = new Error('Feishu BLE write failed');
        failure.code = error && (error.errno || error.errCode);
        reject(failure);
      }
    }));
  });
}

function notificationFrames(decoder, selectedDeviceId, event) {
  if (!event || event.deviceId !== selectedDeviceId ||
      normalizeUuid(event.serviceId) !== SERVICE ||
      normalizeUuid(event.characteristicId) !== NOTIFIER) return [];
  return decoder.push(event.value);
}

module.exports = {
  SERVICE: SERVICE, WRITER: WRITER, NOTIFIER: NOTIFIER, normalizeUuid: normalizeUuid,
  apiAvailability: apiAvailability, writeFrame: writeFrame, notificationFrames: notificationFrames
};
