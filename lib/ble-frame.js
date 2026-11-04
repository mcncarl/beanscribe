/* D3200 packet framing only. No key agreement, decryption or audio decoding. */
var MAX_WRITE_BYTES = 20;
var MAX_FRAME_BYTES = 65535;
var RX_MAGIC = [9, 255, 0, 0];

function bytes(value) {
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (!Array.isArray(value) || !value.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
    throw new Error('Expected bytes');
  }
  return value.slice();
}

function fromHex(value) {
  if (typeof value !== 'string') throw new Error('Expected hex string');
  var hex = value.replace(/^0x/i, '');
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('Invalid hex string');
  var result = [];
  for (var index = 0; index < hex.length; index += 2) result.push(parseInt(hex.slice(index, index + 2), 16));
  return result;
}

function toHex(value) {
  return '0x' + bytes(value).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
}

function checksum(value) {
  return value.reduce(function (total, n) { return (total + n) & 255; }, 0);
}

function command(type, id, payload) {
  var body = [8, 238, 0, 0, 0, type, id, (payload.length + 10) & 255, (payload.length + 10) >> 8].concat(payload);
  return body.concat(checksum(body));
}

function readDeviceInfo() {
  return command(1, 1, []);
}

function ephemeralPublicKey(publicKey) {
  var key = bytes(publicKey);
  if (key.length !== 65 || key[0] !== 4) throw new Error('Expected a 65-byte uncompressed P-256 public point');
  return command(46, 1, key);
}

function listFiles(page) {
  if (page === undefined) page = 0;
  if (!Number.isInteger(page) || page < 0 || page > 65535) throw new Error('Invalid file-list page');
  return command(26, 14, [page & 255, page >> 8]);
}

// The first four bytes are the byte offset to send from, in the recorder's
// 166-byte slices; the vendor app resumes a transfer with (lastSequence + 1) * 166.
// Zero is a fresh transfer, which in live mode starts at the recorder's current position.
function readAudio(fileId, mode, offset) {
  if (offset === undefined) offset = 0;
  if (!Number.isInteger(fileId) || fileId < 1 || fileId > 0xffffffff || !['live', 'replay'].includes(mode) ||
      !Number.isInteger(offset) || offset < 0 || offset > 0xffffffff || offset % 166) {
    throw new Error('Explicit file ID, live/replay mode and a slice-aligned offset required');
  }
  return command(26, 7, [offset & 255, (offset >>> 8) & 255, (offset >>> 16) & 255, offset >>> 24,
    fileId & 255, (fileId >>> 8) & 255, (fileId >>> 16) & 255, fileId >>> 24, mode === 'live' ? 1 : 0]);
}

// 1A/10 deletes one file the recorder holds, named by its uint32 LE id. The
// vendor SDK sends one id per command and waits for each answer.
function deleteFile(fileId) {
  if (!Number.isInteger(fileId) || fileId < 1 || fileId > 0xffffffff) throw new Error('Explicit file ID required');
  return command(26, 16, [fileId & 255, (fileId >>> 8) & 255, (fileId >>> 16) & 255, fileId >>> 24]);
}

function validateOutgoing(value) {
  var frame = bytes(value);
  if (frame.length < 10 || frame[0] !== 8 || frame[1] !== 238 || frame[2] || frame[3] || frame[4] ||
      (frame[7] | (frame[8] << 8)) !== frame.length || checksum(frame.slice(0, -1)) !== frame[frame.length - 1]) {
    throw new Error('Invalid outgoing frame');
  }
  var infoRead = frame[5] === 1 && frame[6] === 1 && frame.length === 10;
  var ephemeralExchange = frame[5] === 46 && frame[6] === 1 && frame.length === 75 && frame[9] === 4;
  var fileList = frame[5] === 26 && frame[6] === 14 && frame.length === 12;
  var audioRead = frame[5] === 26 && frame[6] === 7 && frame.length === 19 &&
    ((frame[9] | (frame[10] << 8) | (frame[11] << 16) | (frame[12] << 24)) >>> 0) % 166 === 0 &&
    frame.slice(13, 17).some(function (n) { return n !== 0; }) && frame[17] <= 1;
  var fileDelete = frame[5] === 26 && frame[6] === 16 && frame.length === 14 && frame.slice(9, 13).some(function (n) { return n !== 0; });
  if (!infoRead && !ephemeralExchange && !fileList && !audioRead && !fileDelete) throw new Error('Command is outside the diagnostic allowlist');
  return frame;
}

function prepareWrite(value, capabilities) {
  var frame = validateOutgoing(value);
  var limit = capabilities && capabilities.maxWriteBytes !== undefined ? capabilities.maxWriteBytes : MAX_WRITE_BYTES;
  if (limit !== 20 && limit !== 75) throw new Error('Only documented 20-byte or explicit 75-byte diagnostic capability is supported');
  if (frame.length > limit) {
    var error = new Error('Feishu documents a 20-byte write limit; D3200 fragmentation is unverified');
    error.code = 'FEISHU_WRITE_LIMIT';
    error.frameBytes = frame.length;
    throw error;
  }
  // The Android native decoder does not strip 0x; keep platform input canonical.
  return toHex(frame).slice(2);
}

// Android SDK's separate authentication rejection predicate. Its length field is
// 2, not the ordinary total frame length, and the native branch checks no checksum.
function authenticationRejection(value) {
  var input = typeof value === 'string' ? fromHex(value) : bytes(value);
  if (input.length < 11 || input[0] !== 9 || input[1] !== 255 || (input[7] | (input[8] << 8)) !== 2) return null;
  if ((input[5] === 26 || input[5] === 27) && input[6] >= 1 && input[6] < 7) return null;
  if (input[9] !== 254 && input[9] !== 255) return null;
  return { type: input[5], id: input[6], status: input[4] & 15, payload: [input[9]],
    authenticationRejected: true, authenticationCode: input[9], checksumVerified: false,
    diagnosticRawHex: toHex(input.slice(0, 11)).slice(2), notificationBytes: input.length };
}

function FrameDecoder() {
  this.buffer = [];
  this.invalidFrames = 0;
}

FrameDecoder.prototype.push = function (chunk) {
  var input = typeof chunk === 'string' ? fromHex(chunk) : bytes(chunk);
  if (input.length + this.buffer.length > MAX_FRAME_BYTES * 2) {
    this.buffer = [];
    throw new Error('BLE receive buffer limit exceeded');
  }
  this.buffer = this.buffer.concat(input);
  var result = [];
  while (this.buffer.length >= 4) {
    if (this.buffer[0] === 9 && this.buffer[1] === 255) {
      if (this.buffer.length < 9) break;
      if ((this.buffer[7] | (this.buffer[8] << 8)) === 2) {
        if (this.buffer.length < 11) break;
        var rejection = authenticationRejection(this.buffer.slice(0, 11));
        if (rejection) { rejection.reassembled = true; this.buffer.splice(0, 11); result.push(rejection); continue; }
      }
    }
    if (!RX_MAGIC.every(function (byte, i) { return byte === this.buffer[i]; }, this)) {
      this.buffer.shift();
      continue;
    }
    if (this.buffer.length < 10) break;
    var length = this.buffer[7] | (this.buffer[8] << 8);
    if (length < 10 || length > MAX_FRAME_BYTES) {
      this.invalidFrames++;
      this.buffer.shift();
      continue;
    }
    if (this.buffer.length < length) break;
    var packet = this.buffer.slice(0, length);
    if (checksum(packet.slice(0, -1)) !== packet[length - 1]) {
      this.invalidFrames++;
      this.buffer.shift();
      continue;
    }
    this.buffer.splice(0, length);
    result.push({ type: packet[5], id: packet[6], status: packet[4] & 15, payload: packet.slice(9, -1) });
  }
  return result;
};

module.exports = {
  fromHex: fromHex, toHex: toHex, readDeviceInfo: readDeviceInfo,
  ephemeralPublicKey: ephemeralPublicKey, listFiles: listFiles, readAudio: readAudio, deleteFile: deleteFile, prepareWrite: prepareWrite,
  authenticationRejection: authenticationRejection,
  FrameDecoder: FrameDecoder, MAX_WRITE_BYTES: MAX_WRITE_BYTES
};
