"""Recover audio captured when the gateway dies uncleanly (force kill / power loss).

No real device, credentials or paid API. A clean stop patches the WAV header on
close; only an unclean exit leaves it stale, so these tests build that exact
on-disk state (a canonical header whose data size is the first frame while the
full PCM follows) and prove the recovery grows it back without fabricating audio.
"""
import json
import struct
import time
import unittest
import uuid
import wave
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

from gateway import Gateway, recover_wav_header, write_json

WORK = Path(__file__).resolve().parents[1] / 'work' / 'tests' / 'test_recovery'
FRAME = (b'\x11\x22' * 320)  # 320 samples * 2 bytes = 640 bytes = 20 ms @ 16 kHz


def canonical_header(data_size):
    return (b'RIFF' + struct.pack('<I', 36 + data_size) + b'WAVE' +
            b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 16000, 32000, 2, 16) +
            b'data' + struct.pack('<I', data_size))


def write_killed_wav(path, frames):
    """The exact bytes a SIGKILL leaves: header stuck at the first frame, full PCM on disk."""
    path.write_bytes(canonical_header(len(FRAME)) + FRAME * frames)
    return frames * 20


def write_clean_wav(path, frames):
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(FRAME * frames)
    return frames * 20


class RecoverWavHeaderTests(unittest.TestCase):
    def setUp(self):
        self.directory = WORK / uuid.uuid4().hex
        self.directory.mkdir(parents=True)

    def test_truncated_header_grows_to_the_full_audio_on_disk(self):
        path = self.directory / 'killed.wav'
        duration = write_killed_wav(path, 50)  # 1000 ms captured, header claims 20 ms
        with wave.open(str(path), 'rb') as audio:
            self.assertEqual(audio.getnframes(), 320)  # reads one frame before repair
        self.assertEqual(recover_wav_header(path), duration)
        with wave.open(str(path), 'rb') as audio:
            self.assertEqual(audio.getnframes(), 16000)  # full second recovered
            self.assertEqual(audio.readframes(16000), FRAME * 50)

    def test_recovery_is_idempotent_and_never_rewrites_a_repaired_file(self):
        path = self.directory / 'killed.wav'
        write_killed_wav(path, 50)
        self.assertEqual(recover_wav_header(path), 1000)
        repaired = path.read_bytes()
        self.assertIsNone(recover_wav_header(path))  # nothing left to grow
        self.assertEqual(path.read_bytes(), repaired)

    def test_a_cleanly_closed_file_is_left_untouched(self):
        path = self.directory / 'clean.wav'
        write_clean_wav(path, 50)
        before = path.read_bytes()
        self.assertIsNone(recover_wav_header(path))
        self.assertEqual(path.read_bytes(), before)

    def test_empty_and_foreign_files_are_not_claimed_as_recovered(self):
        empty = self.directory / 'empty.wav'
        empty.write_bytes(canonical_header(0))
        self.assertIsNone(recover_wav_header(empty))
        wrong = self.directory / 'wrong.wav'
        wrong.write_bytes(b'RIFF' + struct.pack('<I', 36) + b'WAVE' + b'fmt ' +
                          struct.pack('<IHHIIHH', 16, 1, 2, 44100, 176400, 4, 16) + b'data' +
                          struct.pack('<I', 4) + FRAME)
        self.assertIsNone(recover_wav_header(wrong))  # 44.1 kHz stereo is not our format
        self.assertIsNone(recover_wav_header(self.directory / 'missing.wav'))

    def test_a_header_claiming_more_than_exists_is_never_shrunk(self):
        path = self.directory / 'overlong.wav'
        path.write_bytes(canonical_header(len(FRAME) * 50) + FRAME)  # header says 1000 ms, 20 ms on disk
        before = path.read_bytes()
        self.assertIsNone(recover_wav_header(path))
        self.assertEqual(path.read_bytes(), before)


class RecoverRecordingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = WORK / uuid.uuid4().hex
        self.gateway = Gateway(self.directory / 'recordings', self.directory / 'token', 'http://127.0.0.1:1')
        self.client = TestClient(TestServer(self.gateway.application()))
        await self.client.start_server()
        self.gateway.origin = str(self.client.make_url('/')).rstrip('/')
        self.headers = {'Origin': self.gateway.origin}

    async def asyncTearDown(self):
        await self.client.close()

    async def login(self):
        response = await self.client.post('/api/session', json={'token': self.gateway.token}, headers=self.headers)
        self.assertEqual(response.status, 200)

    def killed_recording(self, ident, frames=50, status='waiting_for_audio'):
        path = self.gateway.data / ident
        path.mkdir()
        duration = write_killed_wav(path / 'audio.wav', frames)
        write_json(path / 'result.json', {'status': status, 'sourceType': 'live_device',
                   'language': 'zh', 'recordingId': ident, 'title': 'soundcore Work 录音', 'frames': 0})
        return duration

    def test_startup_recovers_the_full_audio_and_marks_provenance(self):
        duration = self.killed_recording('killed')
        self.assertEqual(self.gateway.recover_recordings(), ['killed'])
        result = json.loads((self.gateway.data / 'killed' / 'result.json').read_text())
        self.assertTrue(result['audioRecovered'])
        self.assertEqual(result['recoveredAudioMs'], duration)
        self.assertEqual(result['durationMs'], duration)
        self.assertNotEqual(result['status'], 'completed')
        record = self.gateway.record('killed')
        self.assertEqual(record['state'], 'error')      # honest: it was interrupted
        self.assertTrue(record['recovered'])
        self.assertEqual(record['durationMs'], duration)
        self.assertEqual(record['segments'], [])        # realtime text was never finalized
        self.assertTrue(record['audioUrl'])

    def test_recovery_is_idempotent_across_restarts(self):
        self.killed_recording('killed')
        self.assertEqual(self.gateway.recover_recordings(), ['killed'])
        first = (self.gateway.data / 'killed' / 'result.json').read_bytes()
        self.assertEqual(self.gateway.recover_recordings(), [])
        self.assertEqual((self.gateway.data / 'killed' / 'result.json').read_bytes(), first)

    def test_completed_and_clean_recordings_are_not_touched(self):
        path = self.gateway.data / 'done'
        path.mkdir()
        write_clean_wav(path / 'audio.wav', 50)
        write_json(path / 'result.json', {'status': 'completed', 'durationMs': 1000,
                   'sourceType': 'live_device', 'language': 'zh', 'segments': []})
        self.assertEqual(self.gateway.recover_recordings(), [])
        self.assertFalse(self.gateway.record('done').get('recovered'))

    async def test_startup_pass_runs_on_boot_and_serves_the_recovered_second(self):
        duration = self.killed_recording('killed')
        # A fresh boot on the same data directory must recover during on_startup,
        # exactly as a restart after a crash would — not only on an explicit call.
        rebooted = Gateway(self.gateway.data, self.directory / 'token', 'http://127.0.0.1:1')
        client = TestClient(TestServer(rebooted.application()))
        await client.start_server()
        rebooted.origin = str(client.make_url('/')).rstrip('/')
        try:
            result = json.loads((self.gateway.data / 'killed' / 'result.json').read_text())
            self.assertEqual(result.get('recoveredAudioMs'), duration)
            login = await client.post('/api/session', json={'token': rebooted.token},
                                      headers={'Origin': rebooted.origin})
            self.assertEqual(login.status, 200)
            response = await client.get('/api/audio/killed')
            self.assertEqual(response.status, 200)
            body = await response.read()
            self.assertEqual(len(body), 44 + len(FRAME) * 50)
            self.assertEqual(struct.unpack_from('<I', body, 40)[0], len(FRAME) * 50)
        finally:
            await client.close()

    async def test_recovered_audio_can_still_be_transcribed_from_file(self):
        self.killed_recording('killed')
        self.gateway.recover_recordings()
        await self.login()
        # A recovered recording is interrupted (state error) yet has real audio,
        # so file transcription is allowed; the worker itself is isolated here.
        with patch.object(Gateway, 'launch_speaker_worker', lambda *a, **k: None):
            response = await self.client.post('/api/recordings/killed/speakers', json={}, headers=self.headers)
        self.assertEqual(response.status, 202)
        self.assertEqual(self.gateway.speaker_job('killed')['status'], 'submitting')

    def ended_badly(self, ident, status, frames=50, wav_frames=None, writer=write_clean_wav):
        path = self.gateway.data / ident
        path.mkdir()
        writer(path / 'audio.wav', frames if wav_frames is None else wav_frames)
        write_json(path / 'result.json', {'status': status, 'durationMs': frames * 20, 'frames': frames,
                   'sourceType': 'live_device', 'language': 'zh', 'segments': []})

    async def test_failed_or_interrupted_recording_with_clean_audio_can_be_transcribed(self):
        # A live session that failed or was cut off still closed its WAV cleanly:
        # every received frame is saved, so file recognition may use it.
        await self.login()
        for ident, status in (('failed-clean', 'failed'), ('interrupted-clean', 'interrupted')):
            self.ended_badly(ident, status)
            record = self.gateway.record(ident)
            self.assertEqual(record['state'], 'error')
            self.assertTrue(record['fileAsrAvailable'])
            with patch.object(Gateway, 'launch_speaker_worker', lambda *a, **k: None):
                response = await self.client.post('/api/recordings/%s/speakers' % ident, json={}, headers=self.headers)
            self.assertEqual(response.status, 202)
            self.assertEqual(self.gateway.speaker_job(ident)['status'], 'submitting')

    async def test_audio_that_does_not_match_the_received_frames_is_still_rejected(self):
        await self.login()
        self.ended_badly('short-audio', 'failed', frames=50, wav_frames=49)       # header clean, count differs
        self.ended_badly('stale-header', 'interrupted', writer=write_killed_wav)   # not closed, not yet recovered
        self.ended_badly('no-frames', 'failed', frames=0, wav_frames=0)
        for ident in ('short-audio', 'stale-header', 'no-frames'):
            self.assertFalse(self.gateway.record(ident)['fileAsrAvailable'])
            response = await self.client.post('/api/recordings/%s/speakers' % ident, json={}, headers=self.headers)
            self.assertEqual(response.status, 400)
            self.assertIsNone(self.gateway.speaker_job(ident))

if __name__ == '__main__':
    unittest.main()
