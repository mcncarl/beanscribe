import asyncio
import copy
import json
import unittest
import uuid
import struct
from unittest.mock import patch
from pathlib import Path

import aiohttp
from gateway import write_json
from feishu_docs import Publisher, ApiError, text_block, block_text
from stepfun import short_title

WORK = Path(__file__).resolve().parents[1] / 'work' / 'tests' / 'test_feishu_docs'


class FakeClient:
    def __init__(self):
        self.created = 0
        self.blocks = []
        self.calls = []
        self.create_error = None
        self.secure_error = None
        self.append_lost = False

    async def create(self, title):
        self.created += 1
        self.calls.append('create')
        if self.create_error:
            raise self.create_error
        return 'doc123'

    async def secure(self, ident, owner):
        self.calls.append('secure')
        if self.secure_error:
            raise self.secure_error

    async def children(self, ident):
        self.calls.append('read')
        return copy.deepcopy(self.blocks)

    async def append(self, ident, blocks, token):
        self.calls.append('append')
        self.blocks.extend(copy.deepcopy(blocks))
        if self.append_lost:
            self.append_lost = False
            raise ApiError('connection_result_unknown', 400)


class DocumentJobs(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.path = WORK / uuid.uuid4().hex
        self.path.mkdir(parents=True)
        self.gateway = type('GatewayFixture', (), {'data': self.path, 'http': None})()
        self.client = FakeClient()
        self.summary_calls = 0
        async def summary(*args):
            self.summary_calls += 1
            return {'summary': '只记录这段原话。', 'chapters': [{'title': '原话', 'startMs': 10}]}
        self.publisher = Publisher(self.gateway, {'ownerUserId': 'self', 'docBaseUrl': 'https://self.feishu.cn'}, self.client, summary)
        self.record = {'id': 'record1', 'title': '私人记录', 'state': 'stopped', 'audioUrl': '/audio',
                       'createdAt': '2026-10-30', 'durationMs': 1000,
                       'segments': [{'id': 's1', 'source': '我计划休息。', 'speaker': '发言人', 'startMs': 10, 'endMs': 990}]}

    async def finish(self):
        await asyncio.gather(*list(self.publisher.tasks.values()))
        await asyncio.sleep(0)

    async def asyncTearDown(self):
        await self.publisher.close()

    async def test_duplicates_share_one_document_and_private_precedes_content(self):
        await asyncio.gather(*[self.publisher.enqueue(self.record) for _ in range(5)])
        await self.finish()
        self.assertEqual(self.client.created, 1)
        self.assertEqual(self.summary_calls, 1)
        self.assertLess(self.client.calls.index('secure'), self.client.calls.index('append'))
        job = self.publisher.public('record1', self.record)
        self.assertEqual(job['status'], 'ready')
        self.assertFalse(job['stale'])
        self.assertEqual(job['url'], 'https://self.feishu.cn/docx/doc123')
        self.assertTrue(any(block_text(b)[1] == '我计划休息。' for b in self.client.blocks))
        self.assertNotIn('blocks', job)
        self.assertNotIn('record', job)
        changed = copy.deepcopy(self.record)
        changed['segments'][0]['source'] = '已修订'
        self.assertTrue(self.publisher.public('record1', changed)['stale'])
        await self.publisher.enqueue(self.record, retry=True)
        self.assertEqual(self.client.created, 1)

    async def test_summary_title_names_the_recording_but_not_the_document(self):
        async def titled(*args):
            return {'summary': '只记录这段原话。', 'chapters': [], 'title': '周三复盘与预算'}
        self.publisher.summarize = titled
        self.assertNotIn('title', self.publisher.public('record1', self.record))
        await self.publisher.enqueue(self.record)
        await self.finish()
        self.assertEqual(self.publisher.public('record1', self.record)['title'], '周三复盘与预算')
        self.assertEqual(block_text(self.client.blocks[0])[1], '周三复盘与预算')
        # The document's own name stays generic; only its private content carries the summary.
        self.assertNotIn('周三复盘与预算', self.publisher.load('record1')['documentTitle'])

    def test_short_title_trims_model_output_to_one_short_line(self):
        self.assertEqual(short_title('“录音：周三复盘与预算安排。”'), '周三复盘与预算安排')
        self.assertEqual(short_title('  家庭\n旅行   计划 '), '家庭 旅行 计划')
        self.assertEqual(len(short_title('一' * 40)), 16)
        self.assertEqual(short_title(None), '')
        self.assertEqual(short_title(''), '')

    async def test_device_identity_is_absent_from_document_snapshot_and_content(self):
        self.record['sourceIdentity'] = {'jsapiDeviceId': 'synthetic-device-private', 'fileId': 12345}
        await self.publisher.enqueue(self.record)
        await self.finish()
        job = self.publisher.load('record1')
        self.assertNotIn('sourceIdentity', job['record'])
        self.assertNotIn('synthetic-device-private', json.dumps(job))
        self.assertNotIn('synthetic-device-private', json.dumps(self.client.blocks))
        self.assertNotIn('12345', json.dumps(self.client.blocks))

    async def test_unknown_creation_never_retries_even_after_restart(self):
        self.client.create_error = asyncio.TimeoutError()
        await self.publisher.enqueue(self.record)
        await self.finish()
        self.assertEqual(self.publisher.load('record1')['status'], 'uncertain')
        await self.publisher.enqueue(self.record, retry=True)
        await self.publisher.run('record1')
        self.assertEqual(self.client.created, 1)
        self.assertEqual(self.client.blocks, [])

    async def test_definite_create_rejection_can_retry(self):
        self.client.create_error = ApiError(99991672)
        await self.publisher.enqueue(self.record)
        await self.finish()
        self.assertEqual(self.publisher.load('record1')['status'], 'failed')
        self.assertFalse(self.publisher.load('record1')['createPending'])
        self.client.create_error = None
        await self.publisher.enqueue(self.record, retry=True)
        await self.finish()
        self.assertEqual(self.publisher.load('record1')['status'], 'ready')

    async def test_acl_failure_never_writes_private_content_and_reuses_blank_doc(self):
        self.client.secure_error = ApiError(403)
        await self.publisher.enqueue(self.record)
        await self.finish()
        self.assertEqual(self.client.blocks, [])
        self.client.secure_error = None
        await self.publisher.enqueue(self.record, retry=True)
        await self.finish()
        self.assertEqual(self.client.created, 1)
        self.assertEqual(self.publisher.load('record1')['status'], 'ready')

    async def test_lost_append_response_reconciles_without_duplicate_text(self):
        self.client.append_lost = True
        await self.publisher.enqueue(self.record)
        await self.finish()
        size = len(self.client.blocks)
        self.assertGreater(size, 0)
        await self.publisher.enqueue(self.record, retry=True)
        await self.finish()
        self.assertEqual(len(self.client.blocks), size)
        self.assertEqual(self.client.created, 1)
        self.assertEqual(self.publisher.load('record1')['status'], 'ready')

    async def test_remote_edit_stops_resume_instead_of_overwriting(self):
        self.client.append_lost = True
        await self.publisher.enqueue(self.record)
        await self.finish()
        self.client.blocks[0] = text_block('用户在飞书上改了内容')
        await self.publisher.enqueue(self.record, retry=True)
        await self.finish()
        self.assertEqual(self.publisher.load('record1')['status'], 'conflict')
        self.assertEqual(block_text(self.client.blocks[0])[1], '用户在飞书上改了内容')

    async def test_recording_without_saved_audio_cannot_create_doc(self):
        for patch in [{'state': 'error'}, {'audioUrl': None}, {'segments': []}]:
            with self.assertRaises(ValueError):
                await self.publisher.enqueue({**self.record, **patch})
        self.assertEqual(self.client.created, 0)

    async def test_an_interrupted_recording_is_documented_only_from_its_applied_file_transcript(self):
        interrupted = {**self.record, 'state': 'error', 'fileAsrAvailable': True}
        with self.assertRaises(ValueError):   # live text alone: not enough
            await self.publisher.enqueue(interrupted)
        with self.assertRaises(ValueError):   # a file transcript of audio we cannot vouch for
            await self.publisher.enqueue({**interrupted, 'fileAsrAvailable': False, 'speakerDiarization': True})
        await self.publisher.enqueue({**interrupted, 'speakerDiarization': True})
        await self.finish()
        self.assertEqual(self.publisher.load('record1')['status'], 'ready')

    async def test_recording_without_recognized_speech_completes_without_a_document(self):
        from aiohttp.test_utils import TestClient, TestServer
        from gateway import Gateway
        gateway = Gateway(self.path / 'silent', self.path / 'token', 'http://127.0.0.1:1')
        http = TestClient(TestServer(gateway.application()))
        await http.start_server()
        gateway.origin = str(http.make_url('/')).rstrip('/')
        publisher = Publisher(gateway, self.publisher.config, self.client, self.publisher.summarize)
        gateway.documents = publisher
        class Stream:
            def __init__(self, *args):
                self.ws = None
                self.stopped = asyncio.Event()
                self.transcript = type('Transcript', (), {'delta_events': 0, 'final_events': 0,
                    'timing_events': [], 'segments': lambda _: []})()
            async def open(self): self.ws = True
            async def append(self, pcm): pass
            async def finish(self): return []
            async def close(self): pass
        try:
            origin = {'Origin': gateway.origin}
            await http.post('/api/session', json={'token': gateway.token}, headers=origin)
            with patch('gateway.StepStream', Stream):
                ws = await http.ws_connect('/api/stream', headers=origin)
                await ws.send_json({'type': 'start', 'recordingId': 'silent1', 'title': '无识别文字',
                                    'language': 'zh', 'sourceType': 'live_device'})
                self.assertEqual((await ws.receive_json())['type'], 'ready')
                fixture = Path(__file__).resolve().parents[1] / 'test/fixtures/synthetic-opus.bin'
                await ws.send_bytes(struct.pack('<I', 0) + fixture.read_bytes()[:160])
                while (await ws.receive_json())['type'] != 'ack': pass
                await ws.send_json({'type': 'stop'})
                while True:
                    event = await ws.receive_json()
                    if event['type'] in ('complete', 'error'):
                        break
                self.assertEqual(event['type'], 'complete')
                await ws.close()
            saved = gateway.record('silent1')
            self.assertEqual(saved['state'], 'stopped')
            self.assertTrue(saved['audioUrl'])
            self.assertEqual(saved['documentJob']['status'], 'no_text')
            self.assertEqual(self.client.created, 0)
        finally:
            await http.close()

    async def test_restart_skips_completed_recordings_without_speech(self):
        from aiohttp.test_utils import TestClient, TestServer
        from gateway import Gateway
        data = self.path / 'restart'
        write_json(data / 'silent1' / 'result.json', {'status': 'completed', 'automaticDocument': True,
                                                    'segments': [], 'durationMs': 20})
        (data / 'silent1' / 'audio.wav').write_bytes(b'preserved-test-audio')
        config = self.path / 'documents.json'
        config.write_text(json.dumps(self.publisher.config))
        secret = self.path / 'app-secret'
        secret.write_text('unused-test-secret')
        secret.chmod(0o600)
        gateway = Gateway(data, self.path / 'restart-token', 'http://127.0.0.1:1',
                          app_secret_file=secret, documents_config=config)
        http = TestClient(TestServer(gateway.application()))
        try:
            await http.start_server()
            self.assertEqual(gateway.documents.tasks, {})
            self.assertEqual(gateway.record('silent1')['documentJob']['status'], 'no_text')
            self.assertEqual((data / 'silent1' / 'audio.wav').read_bytes(), b'preserved-test-audio')
        finally:
            await http.close()

    async def test_completed_websocket_automatically_queues_without_document_button(self):
        from aiohttp.test_utils import TestClient, TestServer
        from gateway import Gateway
        gateway = Gateway(self.path / 'live', self.path / 'token', 'http://127.0.0.1:1')
        http = TestClient(TestServer(gateway.application()))
        await http.start_server()
        gateway.origin = str(http.make_url('/')).rstrip('/')
        publisher = Publisher(gateway, self.publisher.config, self.client, self.publisher.summarize)
        gateway.documents = publisher
        rows = [{'id': 'speech1', 'source': '已保存的一句话。', 'startMs': 0, 'endMs': 20, 'speaker': '发言人'}]
        class Stream:
            def __init__(self, *args):
                self.ws = None
                self.stopped = asyncio.Event()
                self.transcript = type('Transcript', (), {'delta_events': 1, 'final_events': 1, 'timing_events': [], 'segments': lambda _: rows})()
            async def open(self): self.ws = True
            async def append(self, pcm): pass
            async def finish(self): return rows
            async def close(self): pass
        try:
            origin = {'Origin': gateway.origin}
            await http.post('/api/session', json={'token': gateway.token}, headers=origin)
            with patch('gateway.StepStream', Stream):
                ws = await http.ws_connect('/api/stream', headers=origin)
                await ws.send_json({'type': 'start', 'recordingId': 'live1', 'title': '现场测试',
                                    'language': 'zh', 'sourceType': 'live_device'})
                self.assertEqual((await ws.receive_json())['type'], 'ready')
                fixture = Path(__file__).resolve().parents[1] / 'test/fixtures/synthetic-opus.bin'
                await ws.send_bytes(struct.pack('<I', 0) + fixture.read_bytes()[:160])
                while (await ws.receive_json())['type'] != 'ack': pass
                await ws.send_json({'type': 'stop'})
                while (await ws.receive_json())['type'] != 'complete': pass
                await ws.close()
                await asyncio.gather(*list(publisher.tasks.values()))
            saved = gateway.record('live1')
            self.assertEqual(saved['title'], '现场测试')
            self.assertEqual(saved['state'], 'stopped')
            self.assertEqual(saved['documentJob']['status'], 'ready')
            self.assertFalse(saved['documentJob']['stale'])
            self.assertEqual(self.client.created, 1)
            denied = await http.post('/api/recordings/live1/document', json={}, headers={'Origin': 'https://evil.test'})
            self.assertEqual(denied.status, 403)
            repeated = await http.post('/api/recordings/live1/document', json={}, headers=origin)
            self.assertEqual((await repeated.json())['job']['documentId'], 'doc123')
            self.assertEqual(self.client.created, 1)
        finally:
            await http.close()


if __name__ == '__main__':
    unittest.main()
