/* Vendored fflate 0.8.2, MIT. Only synchronous APIs are used: no worker/WASM. */
var fflate = require('../vendor/fflate-0.8.2');
var binary = require('./binary');

function crc32(value) {
  var data = binary.bytes(value), crc = 0xffffffff;
  for (var i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function compress(value) {
  return fflate.gzipSync(binary.bytes(value), { level: 1, mtime: 0 });
}

function decompress(value, maximumBytes) {
  var data = binary.bytes(value);
  var limit = maximumBytes === undefined ? 1024 * 1024 : maximumBytes;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4 * 1024 * 1024) throw new Error('Invalid gzip output limit');
  if (data.length < 18 || data[0] !== 31 || data[1] !== 139 || data[2] !== 8 || (data[3] & 224)) throw new Error('Invalid gzip header');
  var trailer = new DataView(data.buffer, data.byteOffset + data.length - 8, 8);
  var expectedSize = trailer.getUint32(4, true);
  var expectedCrc = trailer.getUint32(0, true);
  if (expectedSize > limit) throw new Error('Gzip output limit exceeded');
  var offset = 10, trailerStart = data.length - 8;
  if (data[3] & 4) {
    if (offset + 2 > trailerStart) throw new Error('Truncated gzip extra field');
    var extraLength = data[offset] | (data[offset + 1] << 8);
    offset += 2 + extraLength;
    if (offset > trailerStart) throw new Error('Truncated gzip extra field');
  }
  [8, 16].forEach(function (flag) {
    if (data[3] & flag) {
      while (offset < trailerStart && data[offset] !== 0) offset++;
      if (offset >= trailerStart) throw new Error('Truncated gzip name or comment');
      offset++;
    }
  });
  if (data[3] & 2) {
    if (offset + 2 > trailerStart || (crc32(data.subarray(0, offset)) & 65535) !== (data[offset] | (data[offset + 1] << 8))) {
      throw new Error('Invalid gzip header checksum');
    }
    offset += 2;
  }
  if (offset >= trailerStart) throw new Error('Missing gzip DEFLATE data');
  var compressed = data.subarray(offset, trailerStart);
  var chunks = [], size = 0, completed = false;
  // Bounded compressed chunks let us enforce expansion limits before accepting
  // the next input chunk. Do not allocate an output buffer from untrusted ISIZE.
  var stream = new fflate.Inflate(function (chunk, final) {
    size += chunk.length;
    if (size > limit || size > expectedSize) throw new Error('Gzip output limit exceeded');
    chunks.push(chunk);
    if (final) completed = true;
  });
  for (var position = 0; position < compressed.length; position += 1024) {
    stream.push(compressed.subarray(position, Math.min(position + 1024, compressed.length)), position + 1024 >= compressed.length);
  }
  // fflate 0.8.2's public gunzip API does not report consumed input. Its pinned
  // Inflate implementation retains the unconsumed bytes in p and the consumed
  // low bit offset in s.p (lib/browser.cjs Inflate.c). At most one partially
  // consumed final byte may remain. Check these exact internals under lock;
  // upgrading fflate requires re-running the trailing-data regression tests.
  if (!stream.s || !stream.s.f || stream.s.l || !stream.p ||
      stream.p.length !== (stream.s.p ? 1 : 0)) {
    throw new Error('Trailing gzip data or incomplete DEFLATE stream');
  }
  var output = binary.concat(chunks);
  // fflate does not validate the gzip trailer CRC itself.
  if (!completed || output.length !== expectedSize || crc32(output) !== expectedCrc) throw new Error('Invalid gzip size or checksum');
  return output;
}

module.exports = { compress: compress, decompress: decompress, crc32: crc32 };
