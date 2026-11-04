const { webcrypto } = require('node:crypto');
const vector = require('./fixtures/d3200-vectors.json');
const wire = require('../lib/ble-frame');
const ble = require('../lib/feishu-ble');
const hex = value => new Uint8Array(Buffer.from(value, 'hex'));
const pendingCrypto = new Set();
function tracked(promise) {
  const operation = Promise.resolve(promise);
  pendingCrypto.add(operation);
  operation.then(() => pendingCrypto.delete(operation), () => pendingCrypto.delete(operation));
  return operation;
}
function provider() {
  return { subtle: new Proxy(webcrypto.subtle, { get(target, key) {
    if (key === 'generateKey') return () => tracked((async () => ({
      privateKey: await webcrypto.subtle.importKey('jwk', vector.client_jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
      publicKey: await webcrypto.subtle.importKey('raw', hex(vector.client_public_hex), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
    }))());
    return typeof target[key] === 'function' ? (...args) => tracked(target[key](...args)) : target[key];
  } }) };
}
function packet(type, id, payload = [], status = 1) {
  const size = payload.length + 10;
  const bytes = [9, 255, 0, 0, status, type, id, size & 255, size >>> 8, ...payload];
  return bytes.concat(bytes.reduce((a, b) => (a + b) & 255, 0));
}
function mockApi(options = {}) {
  const calls = [], hooks = {}, held = {};
  const api = {};
  function event(type, id, payload, status = 1, overrides = {}) {
    const value = wire.toHex(packet(type, id, payload, status));
    if (hooks.value) hooks.value({ deviceId: 'bean', serviceId: ble.SERVICE, characteristicId: ble.NOTIFIER, value, ...overrides });
  }
  function okay(name, result = {}) { api[name] = args => { calls.push({ name, args }); args.success(result); }; }
  ['openBluetoothAdapter', 'startBluetoothDevicesDiscovery', 'stopBluetoothDevicesDiscovery', 'notifyBLECharacteristicValueChange', 'disconnectBLEDevice'].forEach(name => okay(name));
  api.connectBLEDevice = args => { calls.push({ name: 'connectBLEDevice', args }); if (options.holdConnect) held.connect = args; else args.success({}); };
  okay('getBLEDeviceServices', { services: [{ serviceId: ble.SERVICE }] });
  okay('getBLEDeviceCharacteristics', { characteristics: [
    { characteristicId: ble.WRITER, properties: { write: true } }, { characteristicId: ble.NOTIFIER, properties: { notify: true } }
  ] });
  for (const [suffix, key] of [['BluetoothDeviceFound', 'found'], ['BLECharacteristicValueChange', 'value'], ['BLEConnectionStateChange', 'connection']]) {
    api['on' + suffix] = fn => { hooks[key] = fn; calls.push({ name: 'on' + suffix }); };
    api['off' + suffix] = fn => { if (hooks[key] === fn) delete hooks[key]; calls.push({ name: 'off' + suffix, callback: fn }); };
  }
  api.writeBLECharacteristicValue = args => {
    calls.push({ name: 'writeBLECharacteristicValue', args });
    if (options.writeFailure) { args.fail({ errCode: 10017 }); return; }
    args.success({});
    if (options.manualAck) return;
    const frame = wire.fromHex(args.value), type = frame[5], id = frame[6];
    queueMicrotask(() => {
      if (type === 1) event(type, id, Array(55).fill(0));
      else if (type === 46) event(type, id, hex(vector.handshake_hex));
      else if (id === 14) {
        // Ten entries a page (file id, duration ms), then the active file and its duration.
        const page = frame[9] | (frame[10] << 8), entries = (options.files || []).slice(page * 10, page * 10 + 10);
        const list = new Uint8Array(2 + entries.length * 8 + 8), view = new DataView(list.buffer);
        view.setUint16(0, entries.length, true);
        entries.forEach((file, i) => { view.setUint32(2 + i * 8, file.fileId, true); view.setUint32(6 + i * 8, file.durationMs, true); });
        if (options.activeFile !== false) view.setUint32(2 + entries.length * 8, options.activeId || vector.file_id, true);
        event(type, id, list);
      } else if (id === 16) {
        const fileId = (frame[9] | (frame[10] << 8) | (frame[11] << 16) | (frame[12] << 24)) >>> 0;
        const status = options.deleteStatus ? options.deleteStatus(fileId) : 1;
        if (status === null) return; // left unanswered
        if (status === 1 && options.files) options.files.splice(options.files.findIndex(file => file.fileId === fileId), 1);
        event(type, id, [], status);
      } else if (id === 7) {
        // A recorder that will not read from an offset refuses by status or by header code.
        const offset = (frame[9] | (frame[10] << 8) | (frame[11] << 16) | (frame[12] << 24)) >>> 0, header = hex(vector.header_hex);
        if (offset && options.refuseOffset === 'status') event(type, id, header, 2);
        else if (offset && options.refuseOffset === 'header') { header[86] = 3; event(type, id, header); }
        else event(type, id, header);
      }
    });
  };
  return { api, calls, hooks, held, event };
}
async function ticks(count = 20) {
  // setImmediate turns alone can run before libuv's crypto workers finish,
  // especially on Linux CI. Finish observed crypto before injecting the next
  // device ACK or asserting delivered frames; no arbitrary wall-clock delay.
  for (let i = 0; i < count; i++) {
    await Promise.allSettled(Array.from(pendingCrypto));
    await new Promise(resolve => setImmediate(resolve));
  }
}
module.exports = { vector, provider, hex, packet, mockApi, ticks };
