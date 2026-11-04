/* Portable binary helpers: no Buffer, TextEncoder, browser DOM or WebAssembly. */
function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) return new Uint8Array(value);
  throw new Error('Expected Uint8Array or ArrayBuffer');
}

function concat(chunks) {
  var parts = chunks.map(bytes);
  var length = parts.reduce(function (size, part) { return size + part.length; }, 0);
  if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) throw new Error('Binary allocation limit exceeded');
  var result = new Uint8Array(length);
  var offset = 0;
  parts.forEach(function (part) { result.set(part, offset); offset += part.length; });
  return result;
}

function arrayBuffer(value) {
  var data = bytes(value);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function utf8Encode(text) {
  if (typeof text !== 'string') throw new Error('Expected text');
  var output = [];
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      var low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error('Unpaired UTF-16 surrogate');
      code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Unpaired UTF-16 surrogate');
    if (code < 0x80) output.push(code);
    else if (code < 0x800) output.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) output.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else output.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(output);
}

function utf8Decode(value) {
  var data = bytes(value);
  var output = [];
  for (var i = 0; i < data.length;) {
    var first = data[i++], code, count, minimum;
    if (first < 0x80) { code = first; count = 0; minimum = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { code = first & 31; count = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { code = first & 15; count = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { code = first & 7; count = 3; minimum = 0x10000; }
    else throw new Error('Invalid UTF-8 lead byte');
    if (i + count > data.length) throw new Error('Truncated UTF-8');
    for (var j = 0; j < count; j++) {
      var next = data[i++];
      if ((next & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 continuation');
      code = (code << 6) | (next & 63);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid UTF-8 code point');
    if (code <= 0xffff) output.push(String.fromCharCode(code));
    else {
      code -= 0x10000;
      output.push(String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023)));
    }
  }
  return output.join('');
}

module.exports = { bytes: bytes, concat: concat, arrayBuffer: arrayBuffer, utf8Encode: utf8Encode, utf8Decode: utf8Decode };
