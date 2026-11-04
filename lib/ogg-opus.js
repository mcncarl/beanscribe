/* Ogg/Opus mapping: RFC 3533 + RFC 7845. Input must already be authenticated,
 * decrypted, and split into COMPLETE Opus packets. Bytes are never stripped.
 * This module validates framing, not the compressed audio's audible content.
 */
var binary = require('./binary');
var MAX_PACKET_BYTES = 1024 * 1024;

function crc32Ogg(value) {
  var data = binary.bytes(value), crc = 0;
  for (var i = 0; i < data.length; i++) {
    crc ^= data[i] << 24;
    for (var bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
  }
  return crc >>> 0;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid ' + label);
  return value;
}

function opusPacketInfo(value) {
  var packet = binary.bytes(value);
  if (!packet.length || packet.length > MAX_PACKET_BYTES) throw new Error('Invalid Opus packet length');
  var config = packet[0] >> 3;
  var samplesPerFrame = config >= 16 ? 120 * Math.pow(2, config & 3) :
    config >= 12 ? 480 * Math.pow(2, config & 1) : [480, 960, 1920, 2880][config & 3];
  var code = packet[0] & 3, frames, position = 1, end = packet.length, lengths = [];
  function frameLength() {
    if (position >= end) throw new Error('Truncated Opus frame length');
    var length = packet[position++];
    if (length >= 252) {
      if (position >= end) throw new Error('Truncated Opus frame length');
      length += 4 * packet[position++];
    }
    return length;
  }
  if (code === 0) { frames = 1; lengths.push(end - position); }
  else if (code === 1) {
    frames = 2;
    if ((end - position) % 2) throw new Error('Invalid Opus CBR frame lengths');
    lengths.push((end - position) / 2, (end - position) / 2);
  } else if (code === 2) {
    frames = 2;
    var firstLength = frameLength();
    lengths.push(firstLength, end - position - firstLength);
  } else {
    if (packet.length < 2) throw new Error('Truncated Opus frame count');
    var control = packet[position++];
    frames = control & 63;
    if (!frames || frames * samplesPerFrame > 5760) throw new Error('Invalid Opus packet duration');
    if (control & 64) {
      var padding = 0, paddingByte;
      do {
        if (position >= end) throw new Error('Truncated Opus padding');
        paddingByte = packet[position++];
        padding += paddingByte === 255 ? 254 : paddingByte;
        if (padding > end - position) throw new Error('Invalid Opus padding length');
      } while (paddingByte === 255);
      end -= padding;
    }
    if (control & 128) {
      var total = 0;
      for (var frame = 0; frame < frames - 1; frame++) { var length = frameLength(); lengths.push(length); total += length; }
      lengths.push(end - position - total);
    } else {
      var remaining = end - position;
      if (remaining < 0 || remaining % frames) throw new Error('Invalid Opus CBR frame lengths');
      for (var n = 0; n < frames; n++) lengths.push(remaining / frames);
    }
  }
  if (frames * samplesPerFrame > 5760 || lengths.some(function (length) { return length < 0 || length > 1275; })) {
    throw new Error('Invalid Opus frame size or duration');
  }
  return { samples48k: frames * samplesPerFrame, frames: frames, channels: (packet[0] & 4) ? 2 : 1, packetBytes: packet.length };
}

function makePage(serial, sequence, flags, granule, lacing, body) {
  var page = new Uint8Array(27 + lacing.length + body.length);
  page.set([79, 103, 103, 83, 0, flags]);
  var view = new DataView(page.buffer);
  if (granule === -1) { view.setUint32(6, 0xffffffff, true); view.setUint32(10, 0xffffffff, true); }
  else { view.setUint32(6, granule >>> 0, true); view.setUint32(10, Math.floor(granule / 4294967296), true); }
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(body, 27 + lacing.length);
  view.setUint32(22, crc32Ogg(page), true);
  return page;
}

function OggOpusMuxer(options) {
  options = options || {};
  this.serial = integer(options.serial, 0, 0xffffffff, 'Ogg serial');
  this.channels = integer(options.channels === undefined ? 1 : options.channels, 1, 2, 'channel count');
  this.inputSampleRate = integer(options.inputSampleRate === undefined ? 16000 : options.inputSampleRate, 0, 192000, 'input sample rate');
  // The device's encoder delay is unknown; caller must choose and record it.
  this.preSkip = integer(options.preSkip, 0, 65535, 'explicit pre-skip');
  this.vendor = typeof options.vendor === 'string' ? options.vendor : 'Feishu caption local prototype';
  if (binary.utf8Encode(this.vendor).length > 1024) throw new Error('Vendor tag too long');
  this.sequence = 0;
  this.granule = 0;
  this.pending = null;
  this.started = false;
  this.finished = false;
}

OggOpusMuxer.prototype.packetPages = function (packet, granule, flags) {
  var lacing = [], remaining = packet.length;
  while (remaining >= 255) { lacing.push(255); remaining -= 255; }
  lacing.push(remaining); // A multiple of 255 still needs a zero terminator.
  var pages = [], offset = 0;
  for (var start = 0; start < lacing.length; start += 255) {
    var segments = lacing.slice(start, start + 255);
    var bytes = segments.reduce(function (sum, length) { return sum + length; }, 0);
    var completes = start + segments.length === lacing.length;
    var pageFlags = (start ? 1 : (flags & 2)) | (completes ? (flags & 4) : 0);
    pages.push(makePage(this.serial, this.sequence++, pageFlags, completes ? granule : -1, segments, packet.subarray(offset, offset + bytes)));
    if (this.sequence > 0xffffffff) throw new Error('Ogg page sequence exhausted');
    offset += bytes;
  }
  return pages;
};

OggOpusMuxer.prototype.headers = function () {
  if (this.started || this.finished) throw new Error('Ogg headers already emitted');
  this.started = true;
  var head = new Uint8Array(19);
  head.set(binary.utf8Encode('OpusHead'));
  head[8] = 1; head[9] = this.channels;
  var view = new DataView(head.buffer);
  view.setUint16(10, this.preSkip, true);
  view.setUint32(12, this.inputSampleRate, true);
  // Zero output gain, mapping family 0 (mono/stereo).
  var vendor = binary.utf8Encode(this.vendor);
  var tags = new Uint8Array(16 + vendor.length);
  tags.set(binary.utf8Encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  // Last four bytes: zero user comments.
  return this.packetPages(head, 0, 2).concat(this.packetPages(tags, 0, 0));
};

OggOpusMuxer.prototype.push = function (value) {
  if (!this.started || this.finished) throw new Error('Ogg stream is not open');
  var packet = binary.bytes(value);
  var info = opusPacketInfo(packet);
  var pages = [];
  if (this.pending) {
    this.granule += this.pending.samples;
    if (!Number.isSafeInteger(this.granule)) throw new Error('Ogg granule limit exceeded');
    pages = this.packetPages(this.pending.packet, this.granule, 0);
  }
  // Hold exactly one packet so finish can put EOS on its actual final page.
  this.pending = { packet: new Uint8Array(packet), samples: info.samples48k };
  return pages;
};

OggOpusMuxer.prototype.finish = function (endTrimSamples48k) {
  if (!this.started || this.finished || !this.pending) throw new Error('No pending Opus packet to finish');
  var trim = integer(endTrimSamples48k === undefined ? 0 : endTrimSamples48k, 0, this.pending.samples, 'end trim');
  var finalGranule = this.granule + this.pending.samples - trim;
  if (!Number.isSafeInteger(finalGranule) || finalGranule < this.preSkip) throw new Error('Final granule is smaller than pre-skip');
  var pages = this.packetPages(this.pending.packet, finalGranule, 4);
  this.granule = finalGranule;
  this.pending = null;
  this.finished = true;
  return pages;
};

module.exports = { OggOpusMuxer: OggOpusMuxer, opusPacketInfo: opusPacketInfo, crc32Ogg: crc32Ogg };
