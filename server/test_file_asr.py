import asyncio
import json
import time
import unittest
import uuid
import wave
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

import file_asr
from gateway import Gateway, write_json

WORK = Path(__file__).resolve().parents[1] / 'work' / 'tests' / 'test_file_asr'
PROVIDER = {'duration': 1, 'result': [{'utterances': [
    {'text': '你好。', 'start_time': 0, 'end_time': 400, 'speaker': {'id': 'spk_1'}},
    {'text': 'Hello.', 'start_time': 500, 'end_time': 1000, 'speaker': {'id': 'spk_2'}}]}]}


class FileResultTests(unittest.TestCase):
    def test_speaker_ids_are_provider_observations_with_exact_timing(self):
        rows = file_asr.parse_result(PROVIDER, 1000, 'job')
        self.assertEqual([r['speaker'] for r in rows], ['发言人 1', '发言人 2'])
        self.assertEqual([r['startMs'] for r in rows], [0, 500])
        self.assertEqual(rows[1]['providerSpeakerId'], 'spk_2')
        for bad in [None, {}, {'id': ''}]:
            value = json.loads(json.dumps(PROVIDER))
            value['result'][0]['utterances'][0]['speaker'] = bad
            with self.assertRaisesRegex(ValueError, '真实发言人'):
                file_asr.parse_result(value, 1000, 'job')

    def test_invalid_timing_cannot_be_reported_as_diarization(self):
        for end in [float('nan'), False, -1, 6000]:
            value = json.loads(json.dumps(PROVIDER))
            value['result'][0]['utterances'][0]['end_time'] = end
            with self.assertRaises(ValueError):
                file_asr.parse_result(value, 1000, 'job')


class SpeakerJobTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = WORK / uuid.uuid4().hex
        self.gateway = Gateway(self.directory / 'recordings', self.directory / 'token', 'http://127.0.0.1:1', base_path='/minutes')
        self.path = self.gateway.data / 'sample'
        self.path.mkdir()
        with wave.open(str(self.path / 'audio.wav'), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(bytes(32000))
        write_json(self.path / 'result.json', {'status': 'completed', 'durationMs': 1000,
                   'sourceType': 'recorded_file_test', 'language': 'zh', 'segments': [
                       {'id': 'stream-one', 'source': '原来的文字', 'speaker': '发言人',
                        'startMs': 0, 'endMs': 1000, 'sourceRevision': 1, 'sourceFinal': True}]})
        self.client = TestClient(TestServer(self.gateway.application()))
        await self.client.start_server()
        self.gateway.origin = str(self.client.make_url('/')).rstrip('/')
        self.headers = {'Origin': self.gateway.origin}
        self.api = '/minutes/api/recordings/sample/speakers'

    async def asyncTearDown(self):
        await self.client.close()

    async def login(self):
        response = await self.client.post('/minutes/api/session', json={'token': self.gateway.token}, headers=self.headers)
        self.assertEqual(response.status, 200)

    async def finish_workers(self):
        await asyncio.gather(*list(self.gateway.speaker_tasks.values()))
        await asyncio.sleep(0)

    def ready_job(self):
        job = {'id': uuid.uuid4().hex, 'status': 'ready', 'durationMs': 1000, 'language': 'zh',
               'capability': 'a' * 43, 'audioBytes': (self.path / 'audio.wav').stat().st_size,
               'audioExpiresAt': time.time() + 3600, 'speakerCount': 2, 'segmentCount': 2}
        job['segments'] = file_asr.parse_result(PROVIDER, 1000, job['id'])
        self.gateway.save_speaker_job('sample', job)
        return job

    async def test_duplicate_submission_is_durable_and_never_applies_without_choice(self):
        await self.login()
        with patch('file_asr.submit', new=AsyncMock(return_value='provider-task')) as submit, patch('file_asr.query', new=AsyncMock(return_value=PROVIDER)):
            first, second = await asyncio.gather(*[self.client.post(self.api, json={}, headers=self.headers) for _ in range(2)])
            self.assertEqual(sorted([first.status, second.status]), [200, 202])
            await self.finish_workers()
            submit.assert_awaited_once()
            job = self.gateway.speaker_job('sample')
            self.assertEqual(job['status'], 'ready')
            response = await self.client.get(self.api)
            public = await response.json()
            self.assertNotIn(job['capability'], json.dumps(public))
            self.assertNotIn('provider-task', json.dumps(public))
            self.assertEqual(self.gateway.record('sample')['segments'][0]['source'], '原来的文字')
            self.assertFalse(self.gateway.record('sample')['speakerDiarization'])
            await self.client.post(self.api, json={}, headers=self.headers)
            submit.assert_awaited_once()

    async def test_single_file_capability_expires_and_is_revoked_after_completion(self):
        job = self.ready_job()
        job['status'] = 'pending'
        self.gateway.save_speaker_job('sample', job)
        url = '/minutes/api/provider-audio/sample/' + job['capability']
        self.assertEqual((await self.client.get('/minutes/api/audio/sample')).status, 401)
        response = await self.client.get(url)
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), (self.path / 'audio.wav').read_bytes())
        self.assertEqual((await self.client.get(url[:-1] + 'b')).status, 404)
        self.assertEqual((await self.client.get(url.replace('/sample/', '/other/'))).status, 404)
        job['audioExpiresAt'] = time.time() - 1
        self.gateway.save_speaker_job('sample', job)
        self.assertEqual((await self.client.get(url)).status, 404)
        job.update(audioExpiresAt=time.time() + 100, status='ready')
        self.gateway.save_speaker_job('sample', job)
        self.assertEqual((await self.client.get(url)).status, 404)

    async def test_apply_detects_concurrent_edits_retains_original_and_rejects_old_snapshots(self):
        await self.login()
        job = self.ready_job()
        original = self.path.joinpath('result.json').read_bytes()
        record = self.gateway.record('sample')
        before_version = record['contentVersion']
        record['segments'][0].update(source='人工修订', contentEdited=True, editedFields=['source'], baseSourceRevision=1)
        response = await self.client.post('/minutes/api/recordings', json=record, headers=self.headers)
        self.assertEqual(response.status, 200)
        response = await self.client.post(self.api + '/apply', json={'expectedContentVersion': before_version}, headers=self.headers)
        self.assertEqual(response.status, 409)
        current = self.gateway.record('sample')
        response = await self.client.post(self.api + '/apply', json={'expectedContentVersion': current['contentVersion']}, headers=self.headers)
        self.assertEqual(response.status, 200)
        applied = (await response.json())['recording']
        self.assertTrue(applied['speakerDiarization'])
        self.assertEqual(len(applied['segments']), 2)
        self.assertEqual(applied['sourceVersion'], job['id'])
        backup = json.loads(next((self.path / 'versions').glob('*.json')).read_text())
        self.assertEqual(backup['segments'][0]['source'], '人工修订')
        self.assertEqual(self.path.joinpath('result.json').read_bytes(), original)
        response = await self.client.post('/minutes/api/recordings', json=record, headers=self.headers)
        self.assertEqual(response.status, 409)
        response = await self.client.post('/minutes/api/recordings', json=applied, headers=self.headers)
        self.assertEqual(response.status, 200)
        await self.client.post(self.api + '/apply', json={}, headers=self.headers)
        self.assertEqual(len(list((self.path / 'versions').glob('*.json'))), 1)

    async def test_uncertain_submission_never_retries(self):
        await self.login()
        with patch('file_asr.submit', new=AsyncMock(side_effect=asyncio.TimeoutError)) as submit:
            await self.client.post(self.api, json={}, headers=self.headers)
            await self.finish_workers()
            self.assertEqual(self.gateway.speaker_job('sample')['status'], 'uncertain')
            await self.client.post(self.api, json={}, headers=self.headers)
            await self.client.get(self.api)
            submit.assert_awaited_once()
        self.assertEqual(self.gateway.record('sample')['segments'][0]['source'], '原来的文字')

    async def test_known_task_resumes_query_without_resubmitting(self):
        await self.login()
        job = self.ready_job()
        job.update(status='query_error', taskId='existing-task')
        self.gateway.save_speaker_job('sample', job)
        with patch('file_asr.submit', new=AsyncMock()) as submit, patch('file_asr.query', new=AsyncMock(return_value=PROVIDER)) as query:
            await self.client.get(self.api)
            await self.finish_workers()
            submit.assert_not_awaited()
            query.assert_awaited_once_with(self.gateway.http, 'existing-task')
            self.assertEqual(self.gateway.speaker_job('sample')['status'], 'ready')

    async def test_missing_speaker_result_is_failure_without_changing_original(self):
        await self.login()
        bad = {'result': [{'utterances': [{'text': 'no speaker', 'start_time': 0, 'end_time': 100}]}]}
        with patch('file_asr.submit', new=AsyncMock(return_value='task')), patch('file_asr.query', new=AsyncMock(return_value=bad)):
            await self.client.post(self.api, json={}, headers=self.headers)
            await self.finish_workers()
        self.assertEqual(self.gateway.speaker_job('sample')['status'], 'failed')
        self.assertFalse(self.gateway.record('sample')['speakerDiarization'])

    async def test_restart_marks_taskless_submissions_uncertain_without_network(self):
        job = self.ready_job()
        job['status'] = 'submitting'
        self.gateway.save_speaker_job('sample', job)
        second = Gateway(self.gateway.data, self.directory / 'token', self.gateway.origin, base_path='/minutes')
        client = TestClient(TestServer(second.application()))
        with patch('file_asr.submit', new=AsyncMock()) as submit, patch('file_asr.query', new=AsyncMock()) as query:
            try:
                await client.start_server()
                self.assertEqual(second.speaker_job('sample')['status'], 'uncertain')
                submit.assert_not_awaited()
                query.assert_not_awaited()
            finally:
                await client.close()


if __name__ == '__main__':
    unittest.main()
