"""Decode complete device Opus packets; never strip trailing zero bytes."""
import ctypes
import ctypes.util
import os
import math
import struct


class OpusDecoder:
    def __init__(self):
        paths = [os.environ.get('SOUNDCORE_OPUS_LIBRARY'), ctypes.util.find_library('opus'),
                 '/opt/homebrew/opt/opus/lib/libopus.0.dylib', '/usr/local/opt/opus/lib/libopus.0.dylib']
        self.lib = None
        for path in paths:
            if path:
                try:
                    self.lib = ctypes.CDLL(path)
                    break
                except OSError:
                    pass
        if self.lib is None:
            raise RuntimeError('libopus unavailable')
        self.lib.opus_decoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        self.lib.opus_decoder_create.restype = ctypes.c_void_p
        self.lib.opus_decode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int,
                                        ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_int]
        self.lib.opus_decode.restype = ctypes.c_int
        self.lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
        error = ctypes.c_int()
        self.decoder = self.lib.opus_decoder_create(16000, 1, ctypes.byref(error))
        if not self.decoder or error.value:
            raise RuntimeError('Opus decoder initialization failed')

    def decode(self, packet):
        if len(packet) != 160:
            raise ValueError('Expected one complete 160-byte D3200 Opus packet')
        data = (ctypes.c_ubyte * len(packet)).from_buffer_copy(packet)
        out = (ctypes.c_short * 1920)()
        count = self.lib.opus_decode(self.decoder, data, len(packet), out, 1920, 0)
        if count != 320:
            raise ValueError('Opus packet did not decode to the expected 20 ms')
        return ctypes.string_at(out, count * 2)

    def close(self):
        if self.decoder:
            self.lib.opus_decoder_destroy(self.decoder)
            self.decoder = None


class QuietRanges:
    """Measured low-volume intervals for optional playback skipping, not speech detection."""
    def __init__(self, threshold=128, minimum_ms=500, margin_ms=100):
        self.threshold, self.minimum_ms, self.margin_ms = threshold, minimum_ms, margin_ms
        self.position = 0
        self.start = None
        self.ranges = []

    def feed(self, pcm):
        if len(pcm) != 640:
            raise ValueError('Expected 20 ms of 16 kHz mono PCM')
        samples = struct.unpack('<320h', pcm)
        rms = math.sqrt(sum(value * value for value in samples) / 320)
        if rms < self.threshold:
            if self.start is None:
                self.start = self.position
        else:
            self._end()
        self.position += 20

    def _end(self):
        if self.start is not None and self.position - self.start >= self.minimum_ms:
            self.ranges.append({'startMs': self.start + self.margin_ms, 'endMs': self.position - self.margin_ms})
        self.start = None

    def finish(self):
        self._end()
        return list(self.ranges)
