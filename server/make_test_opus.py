"""Encode explicit synthetic test PCM into 20 ms CBR packets. Never used on BLE data."""
import argparse
import ctypes
import ctypes.util
from pathlib import Path


def encode(pcm):
    lib = ctypes.CDLL(ctypes.util.find_library('opus') or '/opt/homebrew/opt/opus/lib/libopus.0.dylib')
    lib.opus_encoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    lib.opus_encoder_create.restype = ctypes.c_void_p
    # opus_encoder_ctl is variadic; Apple ARM64 uses a different ABI for the
    # variadic argument. Declare only the fixed prefix and pass typed integers.
    lib.opus_encoder_ctl.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.opus_encoder_ctl.restype = ctypes.c_int
    lib.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_short), ctypes.c_int,
                               ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int]
    lib.opus_encode.restype = ctypes.c_int
    lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
    error = ctypes.c_int()
    encoder = lib.opus_encoder_create(16000, 1, 2049, ctypes.byref(error))
    if not encoder or error.value:
        raise RuntimeError('Opus encoder unavailable')
    output = bytearray()
    try:
        if lib.opus_encoder_ctl(encoder, 4002, ctypes.c_int(64000)) or lib.opus_encoder_ctl(encoder, 4006, ctypes.c_int(0)):
            raise RuntimeError('Opus CBR configuration rejected')
        for offset in range(0, len(pcm), 640):
            samples = (ctypes.c_short * 320).from_buffer_copy(pcm[offset:offset + 640].ljust(640, b'\0'))
            packet = (ctypes.c_ubyte * 160)()
            count = lib.opus_encode(encoder, samples, 320, packet, 160)
            if count != 160:
                raise RuntimeError('Expected one 160-byte CBR packet')
            output.extend(bytes(packet))
    finally:
        lib.opus_encoder_destroy(encoder)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = encode(args.input.read_bytes())
    with args.output.open('xb') as output:
        output.write(data)
