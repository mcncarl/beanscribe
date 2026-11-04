"""Build a public test fixture from a 440 Hz sine wave, never recorded speech."""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
from make_test_opus import encode

frames = 332
pcm = b''.join(struct.pack('<h', round(4000 * math.sin(2 * math.pi * 440 * i / 16000)))
               for i in range(frames * 320))
packets = bytes(encode(pcm))
target = ROOT / 'test/fixtures/synthetic-opus.bin'
with target.open('xb') as stream:
    stream.write(packets)
metadata = {'source': 'synthetic 440 Hz sine wave; no human voice or device recording',
            'sampleRate': 16000, 'channels': 1, 'packetBytes': 160, 'packets': frames,
            'durationMs': frames * 20, 'sha256': hashlib.sha256(packets).hexdigest()}
target.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('Generated public synthetic fixture: %d packets' % frames)
