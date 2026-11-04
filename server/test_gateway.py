import hashlib
import json
import os
import struct
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import gateway as gateway_module

from gateway import Gateway, signing_url, bounded_segments, merge_segments, write_json, normalized_base_path
from opus import OpusDecoder, QuietRanges
from stepfun import Transcript

WORK = Path(__file__).resolve().parents[1] / 'work' / 'tests' / 'test_gateway'


class TranscriptTests(unittest.TestCase):
    def test_padding_timestamps_never_exceed_playable_audio(self):
        source = [{'id': 'last', 'startMs': 7000, 'endMs': 8576, 'source': 'ending'}]
        rows = bounded_segments(source, 7920)
        self.assertEqual((rows[0]['startMs'], rows[0]['endMs']), (7000, 7920))
        self.assertTrue(rows[0]['timingClampedToAudio'])
        self.assertEqual(source[0]['endMs'], 8576)

    def test_stale_snapshots_never_hide_or_replace_finalized_segments(self):
        final = [{'id': 'one', 'source': '最终文字。', 'sourceRevision': 4, 'sourceFinal': True},
                 {'id': 'two', 'source': '下一句。', 'sourceRevision': 1, 'sourceFinal': True}]
        stale = [{'id': 'one', 'source': '最', 'sourceRevision': 1, 'sourceFinal': False,
                  'translation': 'stale translation'}]
        self.assertEqual(merge_segments(final, []), final)
        self.assertEqual(merge_segments(final, stale), final)

    def test_only_explicit_edits_override_final_fields_and_conflicts_are_visible(self):
        final = [{'id': 'one', 'source': '最终文字。', 'sourceRevision': 4, 'sourceFinal': True,
                  'startMs': 50, 'endMs': 1000, 'speaker': '发言人'}]
        edit = [{'id': 'one', 'source': '旧文字', 'sourceRevision': 2, 'startMs': 0, 'endMs': 2000,
                 'speaker': '测试用户', 'contentEdited': True, 'editedFields': ['speaker'], 'baseSourceRevision': 2}]
        row = merge_segments(final, edit)[0]
        self.assertEqual(row['source'], '最终文字。')
        self.assertEqual(row['speaker'], '测试用户')
        self.assertEqual(row['endMs'], 1000)
        self.assertEqual(row['sourceRevision'], 4)
        self.assertTrue(row['contentConflict'])
        self.assertEqual(row['providerSource'], '最终文字。')

    def test_revisions_replace_and_final_is_not_rolled_back(self):
        t = Transcript()
        t.apply({'type': 'input_audio_buffer.speech_started', 'item_id': 'one', 'audio_start_ms': 120})
        first = t.apply({'type': 'conversation.item.input_audio_transcription.delta', 'item_id': 'one',
                         'text': '这', 'stash': '是测试'})
        final = t.apply({'type': 'conversation.item.input_audio_transcription.completed', 'item_id': 'one',
                         'transcript': '这是测试。'})
        stale = t.apply({'type': 'conversation.item.input_audio_transcription.delta', 'item_id': 'one',
                         'text': '错', 'stash': ''})
        self.assertEqual(first['text'], '这是测试')
        self.assertEqual(final['text'], '这是测试。')
        self.assertEqual(final['startMs'], 120)
        self.assertIsNone(final['endMs'])
        self.assertIsNone(stale)
        self.assertFalse(t.pending)
        self.assertEqual(t.segments()[0]['source'], '这是测试。')

    def test_no_80_segment_data_loss(self):
        t = Transcript()
        for i in range(120):
            t.apply({'type': 'conversation.item.input_audio_transcription.completed', 'item_id': str(i),
                     'transcript': 'segment ' + str(i)})
        self.assertEqual(len(t.segments()), 120)

    def test_provider_stopped_field_does_not_replace_start(self):
        t = Transcript()
        t.apply({'type': 'input_audio_buffer.speech_started', 'item_id': 'one', 'audio_start_ms': 512})
        t.apply({'type': 'input_audio_buffer.speech_stopped', 'item_id': 'one', 'audio_start_ms': 5664})
        event = t.apply({'type': 'conversation.item.input_audio_transcription.completed', 'item_id': 'one',
                         'transcript': '这是测试。'})
        self.assertEqual((event['startMs'], event['endMs']), (512, 5664))
        self.assertEqual(t.rows['one']['endTimingBasis'], 'provider_speech_stopped.audio_start_ms')

    def test_sign_only_exact_private_origin_and_page(self):
        origin = 'https://private.example.test'
        allowed = origin + '/preview.html?recording=one'
        self.assertEqual(signing_url(allowed, origin), allowed)
        for url in ['https://evil.test/preview.html', origin + '.evil.test/preview.html',
                    origin + '/preview.html#x', origin + '/other', 'https://user:pass@private.example.test/preview.html']:
            with self.assertRaises(ValueError):
                signing_url(url, origin)

    def test_prefixed_signing_does_not_authorize_other_apps_on_the_same_host(self):
        origin = 'https://private.example.test'
        self.assertEqual(normalized_base_path('/minutes/'), '/minutes')
        self.assertEqual(signing_url(origin + '/minutes/preview.html', origin, '/minutes'),
                         origin + '/minutes/preview.html')
        for path in ['/preview.html', '/minutes-extra/preview.html', '/minutes/../preview.html']:
            with self.assertRaises(ValueError):
                signing_url(origin + path, origin, '/minutes')
        for path in ['minutes', '/a/../b', '//a', '/a?b', '/a%2fb']:
            with self.assertRaises(ValueError):
                normalized_base_path(path)

    def test_complete_synthetic_opus_fixture_decodes_all_frames(self):
        path = Path(__file__).resolve().parents[1] / 'test/fixtures/synthetic-opus.bin'
        data = path.read_bytes()
        decoder = OpusDecoder()
        try:
            pcm = b''.join(decoder.decode(data[i:i + 160]) for i in range(0, len(data), 160))
        finally:
            decoder.close()
        self.assertEqual(len(data) // 160, 332)
        self.assertEqual(len(pcm), 332 * 640)
        samples = struct.unpack('<%dh' % (len(pcm) // 2), pcm)
        rms = (sum(value * value for value in samples) / len(samples)) ** 0.5
        self.assertGreater(rms, 100)
        self.assertLess(rms, 6000)

    def test_quiet_intervals_keep_margins_and_ignore_short_pauses(self):
        detector = QuietRanges()
        loud = struct.pack('<320h', *([1000] * 320))
        for _ in range(30):
            detector.feed(bytes(640))
        detector.feed(loud)
        for _ in range(10):
            detector.feed(bytes(640))
        detector.feed(loud)
        self.assertEqual(detector.finish(), [{'startMs': 100, 'endMs': 500}])


class GatewayBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = WORK / uuid.uuid4().hex
        self.gateway = Gateway(self.directory / 'recordings', self.directory / 'access-token', 'http://127.0.0.1:1')
        self.client = TestClient(TestServer(self.gateway.application()))
        await self.client.start_server()
        self.gateway.origin = str(self.client.make_url('/')).rstrip('/')

    async def asyncTearDown(self):
        await self.client.close()

    async def login(self):
        return await self.client.post('/api/session', json={'token': self.gateway.token},
                                      headers={'Origin': self.gateway.origin})

    async def test_record_link_survives_login_without_accepting_arbitrary_redirects(self):
        response = await self.client.get('/preview.html?recording=record-1', allow_redirects=False)
        self.assertEqual(response.headers['Location'], '/login?recording=record-1')
        response = await self.client.get('/login?recording=record-1')
        self.assertIn('destination="/preview.html?recording=record-1"', await response.text())
        response = await self.client.get('/login?recording=https://evil.test')
        text = await response.text()
        self.assertIn('destination="/h5/index.html"', text)
        self.assertNotIn('evil.test', text)

    async def test_pages_and_audio_are_private_before_login(self):
        response = await self.client.get('/preview.html', allow_redirects=False)
        self.assertEqual(response.status, 302)
        response = await self.client.get('/api/audio/nonexistent')
        self.assertEqual(response.status, 401)
        response = await self.login()
        self.assertEqual(response.status, 200)
        cookie = response.cookies['minutes_session']
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Strict')
        response = await self.client.get('/api/status')
        self.assertEqual(response.status, 200)
        self.assertFalse((await response.json())['deviceVerified'])

    async def test_cross_origin_login_and_host_are_rejected(self):
        response = await self.client.post('/api/session', json={'token': self.gateway.token},
                                          headers={'Origin': 'https://evil.test'})
        self.assertEqual(response.status, 403)
        response = await self.client.get('/healthz', headers={'Host': 'evil.test'})
        self.assertEqual(response.status, 403)

    async def test_code_and_test_paths_not_served(self):
        await self.login()
        for path in ['/server/gateway.py', '/test/offline.test.js', '/../server/gateway.py']:
            response = await self.client.get(path)
            self.assertEqual(response.status, 404)

    async def test_bad_stream_init_does_not_create_recording_or_call_provider(self):
        await self.login()
        ws = await self.client.ws_connect('/api/stream', headers={'Origin': self.gateway.origin})
        await ws.send_json({'type': 'start', 'recordingId': '../escape', 'sourceType': 'live_device'})
        event = await ws.receive_json()
        self.assertEqual(event['type'], 'error')
        await ws.close()
        self.assertEqual(list((self.directory / 'recordings').iterdir()), [])

    async def test_recording_id_collision_preserves_saved_result(self):
        path = self.directory / 'recordings' / 'existing'
        path.mkdir()
        saved = path / 'result.json'
        saved.write_text('{"existing":true}')
        await self.login()
        ws = await self.client.ws_connect('/api/stream', headers={'Origin': self.gateway.origin})
        await ws.send_json({'type': 'start', 'recordingId': 'existing', 'sourceType': 'live_device'})
        event = await ws.receive_json()
        self.assertEqual(event['type'], 'error')
        await ws.close()
        self.assertEqual(saved.read_text(), '{"existing":true}')

    async def test_metadata_roundtrip_does_not_create_audio_directory_or_store_blob(self):
        await self.login()
        body = {'id': 'draft-one', 'title': '测试录音', 'state': 'draft', 'segments': [], 'audioBlob': 'must-not-save'}
        response = await self.client.post('/api/recordings', json=body, headers={'Origin': self.gateway.origin})
        self.assertEqual(response.status, 200)
        response = await self.client.get('/api/recordings/draft-one')
        value = await response.json()
        self.assertEqual(value['title'], '测试录音')
        self.assertNotIn('audioBlob', value)
        self.assertIsNone(value['audioUrl'])
        self.assertFalse((self.directory / 'recordings' / 'draft-one').exists())

    async def test_device_capability_diagnostics_do_not_store_identifiers_or_key_fields(self):
        await self.login()
        body = {'type': 'device_info_capability', 'deviceInfoBytes': 64, 'supportAuthRaw': 1,
                'hasAuthUidRaw': 1, 'supportAuth': True, 'hasAuthUid': True,
                'serialNumber': 'private-serial', 'hardware_key': 'private-key', 'payload': 'private-device-data'}
        response = await self.client.post('/api/diagnostics', json=body, headers={'Origin': self.gateway.origin})
        self.assertEqual(response.status, 200)
        saved = json.loads((self.directory / 'recordings' / '_diagnostics' / 'runtime.jsonl').read_text())
        self.assertTrue(saved['supportAuth'])
        self.assertFalse({'serialNumber', 'hardware_key', 'payload'} & saved.keys())
        body['supportAuthRaw'] = 'private-key'
        response = await self.client.post('/api/diagnostics', json=body, headers={'Origin': self.gateway.origin})
        self.assertEqual(response.status, 400)

    async def test_scan_diagnostics_keep_counts_and_drop_nearby_device_details(self):
        await self.login()
        body = {'type': 'scan_complete', 'eventCount': 2, 'advertisedCount': 3,
                'cachedCount': 5, 'connectedCount': 1, 'matchedCount': 1,
                'devices': [{'deviceId': 'private-device', 'name': 'private-name'}]}
        response = await self.client.post('/api/diagnostics', json=body, headers={'Origin': self.gateway.origin})
        self.assertEqual(response.status, 200)
        saved = json.loads((self.directory / 'recordings' / '_diagnostics' / 'runtime.jsonl').read_text())
        self.assertEqual(saved['matchedCount'], 1)
        self.assertNotIn('devices', saved)
        for invalid in (-1, 10001, True, 'private-name'):
            response = await self.client.post('/api/diagnostics', json={**body, 'eventCount': invalid}, headers={'Origin': self.gateway.origin})
            self.assertEqual(response.status, 400)

    async def test_error_diagnostics_keep_a_bounded_message(self):
        await self.login()
        response = await self.client.post('/api/diagnostics', json={'type': 'error', 'message': '语音连接中断' + 'x' * 400},
                                          headers={'Origin': self.gateway.origin})
        self.assertEqual(response.status, 200)
        saved = json.loads((self.directory / 'recordings' / '_diagnostics' / 'runtime.jsonl').read_text())
        self.assertTrue(saved['message'].startswith('语音连接中断'))
        self.assertEqual(len(saved['message']), 160)
        response = await self.client.post('/api/diagnostics', json={'type': 'error', 'message': {'nested': 1}},
                                          headers={'Origin': self.gateway.origin})
        self.assertEqual(response.status, 400)

    async def test_reopen_final_record_ignores_old_draft_and_marks_summary_stale(self):
        await self.login()
        body = {'id': 'finished-one', 'title': '新标题', 'state': 'draft', 'segments': [],
                'summary': '旧草稿纪要', 'summaryStale': False}
        await self.client.post('/api/recordings', json=body, headers={'Origin': self.gateway.origin})
        write_json(self.directory / 'recordings' / 'finished-one' / 'result.json', {
            'status': 'completed', 'durationMs': 1000, 'sourceType': 'recorded_file_test',
            'segments': [{'id': 'one', 'source': '最终文字', 'sourceRevision': 4, 'sourceFinal': True}]})
        response = await self.client.get('/api/recordings/finished-one')
        row = await response.json()
        self.assertEqual(row['title'], '新标题')
        self.assertEqual(row['state'], 'stopped')
        self.assertEqual(row['segments'][0]['source'], '最终文字')
        self.assertTrue(row['summaryStale'])

    async def test_failed_logins_lock_out_only_the_client_that_failed(self):
        attacker, owner = {'Origin': self.gateway.origin, 'CF-Connecting-IP': '203.0.113.9'}, \
            {'Origin': self.gateway.origin, 'CF-Connecting-IP': '198.51.100.7'}
        for _ in range(20):   # malformed requests are refused without counting
            self.assertEqual((await self.client.post('/api/session', json={}, headers=attacker)).status, 400)
        for _ in range(10):
            self.assertEqual((await self.client.post('/api/session', json={'token': 'x' * 43}, headers=attacker)).status, 401)
        self.assertEqual((await self.client.post('/api/session', json={'token': self.gateway.token}, headers=attacker)).status, 429)
        self.assertEqual((await self.client.post('/api/session', json={'token': self.gateway.token}, headers=owner)).status, 200)

    def test_tunnel_client_address_is_trusted_only_from_a_loopback_peer(self):
        def request(remote, header):
            return SimpleNamespace(remote=remote, headers={'CF-Connecting-IP': header} if header else {})
        self.assertEqual(self.gateway.client_key(request('127.0.0.1', '203.0.113.9')), '203.0.113.9')
        self.assertEqual(self.gateway.client_key(request('::1', '2001:db8::1')), '2001:db8::1')
        self.assertEqual(self.gateway.client_key(request('127.0.0.1', 'not-an-ip')), '127.0.0.1')
        self.assertEqual(self.gateway.client_key(request('192.0.2.4', '203.0.113.9')), '192.0.2.4')

    async def test_non_object_json_bodies_are_400_not_500(self):
        await self.login()
        write_json(self.directory / 'recordings' / 'rec' / 'result.json', {'status': 'completed', 'durationMs': 0})
        for path in ('/api/jsapi-config', '/api/text/summary', '/api/recordings/rec/speakers',
                     '/api/recordings/rec/speakers/apply', '/api/session', '/api/recordings', '/api/diagnostics'):
            with self.subTest(path):
                response = await self.client.post(path, json=['not', 'an', 'object'], headers={'Origin': self.gateway.origin})
                self.assertEqual(response.status, 400)

    async def test_diagnostics_rotate_to_a_single_previous_file(self):
        await self.login()
        folder = self.directory / 'recordings' / '_diagnostics'
        with patch.object(gateway_module, 'DIAGNOSTIC_MAX_BYTES', 400):
            for index in range(30):
                response = await self.client.post('/api/diagnostics', json={'type': 'scan_complete', 'eventCount': index},
                                                  headers={'Origin': self.gateway.origin})
                self.assertEqual(response.status, 200)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ['runtime.jsonl', 'runtime.jsonl.1'])
        self.assertLessEqual((folder / 'runtime.jsonl').stat().st_size, 400)
        self.assertLessEqual((folder / 'runtime.jsonl.1').stat().st_size, 400)
        last = json.loads((folder / 'runtime.jsonl').read_text().splitlines()[-1])
        self.assertEqual(last['eventCount'], 29)


class PrefixedGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_login_static_api_audio_and_websocket_stay_inside_the_private_prefix(self):
        directory = WORK / uuid.uuid4().hex
        gateway = Gateway(directory / 'recordings', directory / 'access-token', 'http://127.0.0.1:1',
                          base_path='/minutes/')
        client = TestClient(TestServer(gateway.application()))
        await client.start_server()
        gateway.origin = str(client.make_url('/')).rstrip('/')
        try:
            response = await client.get('/minutes/preview.html', allow_redirects=False)
            self.assertEqual((response.status, response.headers.get('Location')), (302, '/minutes/login'))
            response = await client.get('/minutes/login')
            self.assertIn('const base="/minutes"', await response.text())
            self.assertEqual((await client.get('/minutes/api/recordings')).status, 401)
            for path in ['/api/status', '/login', '/minutes-extra/api/status']:
                self.assertEqual((await client.get(path, allow_redirects=False)).status, 404)
            response = await client.post('/minutes/api/session', json={'token': gateway.token},
                                         headers={'Origin': gateway.origin})
            self.assertEqual(response.status, 200)
            self.assertEqual(response.cookies['minutes_session']['path'], '/minutes/')
            response = await client.get('/minutes/preview.html')
            self.assertEqual(response.status, 200)
            response = await client.get('/minutes/h5/minutes-runtime.js')
            self.assertEqual(response.status, 200)
            response = await client.get('/minutes/api/status')
            self.assertEqual((await response.json())['basePath'], '/minutes')
            write_json(directory / 'recordings' / 'prefixed' / 'result.json',
                       {'status': 'completed', 'durationMs': 20, 'segments': []})
            (directory / 'recordings' / 'prefixed' / 'audio.wav').write_bytes(b'fixture-audio')
            response = await client.get('/minutes/api/recordings/prefixed')
            record = await response.json()
            self.assertEqual(record['audioUrl'], '/minutes/api/audio/prefixed')
            response = await client.get(record['audioUrl'])
            self.assertEqual(await response.read(), b'fixture-audio')
            ws = await client.ws_connect('/minutes/api/stream', headers={'Origin': gateway.origin})
            await ws.send_json({'type': 'start', 'recordingId': '../escape', 'sourceType': 'live_device'})
            self.assertEqual((await ws.receive_json())['type'], 'error')
            await ws.close()
        finally:
            await client.close()


if __name__ == '__main__':
    unittest.main()
