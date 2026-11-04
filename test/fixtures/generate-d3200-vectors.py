"""Independent Python cryptography oracle. All fixture keys/audio are synthetic.
No device/network access. Optional --source-opus validates an existing local recording.
"""
import argparse
import base64
import hashlib
import json
import struct
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

def ctr(key, iv, plain):
    encryptor = Cipher(algorithms.AES(key), modes.CTR(iv)).encryptor()
    return encryptor.update(plain) + encryptor.finalize()

def b64(number):
    return base64.urlsafe_b64encode(number.to_bytes(32, 'big')).rstrip(b'=').decode()

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=Path(__file__).with_name('d3200-vectors.json'))
parser.add_argument('--source-opus', type=Path)
args = parser.parse_args()
client = ec.derive_private_key(7, ec.SECP256R1())
server = ec.derive_private_key(13, ec.SECP256R1())
public = lambda key: key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
shared = client.exchange(ec.ECDH(), server.public_key())
assert shared == server.exchange(ec.ECDH(), client.public_key())
session = HKDF(algorithm=hashes.SHA256(), length=32, salt=b'\x01\x02\x03', info=b'\x01\x02\x03').derive(shared)
file_key = bytes(range(64, 96))
nonce = bytes(range(16))
header_iv = bytes(range(32, 48))
if args.source_opus:
    raw = args.source_opus.read_bytes()
    assert raw and len(raw) % 160 == 0
    packets = [raw[i:i+160] for i in range(0, len(raw), 160)]
else:
    packets = [bytes([0x98]) + bytes((i * 17 + j) % 256 for i in range(157)) + b'\0\0' for j in range(3)]
header = struct.pack('<II', 12345, len(packets) * 166) + nonce + ctr(session, header_iv, b'soundcored3200' + file_key) + header_iv + b'\0'
assert len(header) == 87
slices = [struct.pack('<I', seq) + b'\0' + ctr(file_key, nonce[:12] + struct.pack('>I', seq * 10), packet) + b'\0' for seq, packet in enumerate(packets)]
numbers = client.private_numbers()
result = {
    'provenance': 'Python cryptography independently generates ECDH, HKDF and AES-CTR ciphertext; all keys are fixed synthetic test values.',
    'client_jwk': {'kty': 'EC', 'crv': 'P-256', 'x': b64(numbers.public_numbers.x), 'y': b64(numbers.public_numbers.y), 'd': b64(numbers.private_value), 'ext': False, 'key_ops': ['deriveBits']},
    'client_public_hex': public(client).hex(), 'handshake_hex': (public(server) + shared).hex(),
    'header_hex': header.hex(), 'file_id': 12345,
    'slices_hex': [s.hex() for s in slices],
    'plain_sha256': hashlib.sha256(b''.join(packets)).hexdigest(),
    'packet_sha256': [hashlib.sha256(p).hexdigest() for p in packets],
    'packet_count': len(packets), 'packet_bytes': 160,
    'plain_hex': [p.hex() for p in packets] if not args.source_opus else None,
}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'output': str(args.output), 'packets': len(packets), 'sha256': result['plain_sha256']}))
