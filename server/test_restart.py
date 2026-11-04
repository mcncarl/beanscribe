"""Service stop, restart sweeps and automatic follow-up work. Loopback and in-memory only:
no real provider, document API, credentials or device."""
import asyncio
import json
import struct
import tempfile
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

import feishu_docs
import gateway as gateway_module
from gateway import Gateway, clean_wav_bytes, write_json
from stepfun import Transcript
from test_feishu_docs import FakeClient
from test_stream_reliability import ControlledStream, SyntheticDecoder

FRAME = b'\x11\x22' * 320
STREAM = [{'id': 'live-1', 'source': '实时字幕的文字', 'startMs': 0, 'endMs': 900,
           'sourceRevision': 0, 'sourceFinal': True}]
FILE = [{'id': 'file-j1-0', 'source': '文件转写的完整文字', 'sourceLanguage': 'zh', 'sourceRevision': 0,
         'sourceFinal': True, 'startMs': 0, 'endMs': 900, 'speaker': '发言人 1', 'providerSpeakerId': 'a'}]


def clean_wav(path, frames):
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(FRAME * frames)


class RestartCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)
        self.data = self.dir / 'records'
        self.data.mkdir()
        self.config = self.dir / 'documents.json'
        self.config.write_text(json.dumps({'ownerUserId': 'owner', 'docBaseUrl': 'https://x.feishu.cn'}))
        self.secret = self.dir / 'secret'
        self.secret.write_text('synthetic')
        self.secret.chmod(0o600)
        self.docs = FakeClient()
        self.summaries = []

        async def text_task(http, task, segments, language='en'):
            if task == 'summary':
                self.summaries.append([row['source'] for row in segments])
                return {'summary': '纪要', 'chapters': [], 'title': ''}
            return {'translations': [{'id': r['id'], 'text': 'T', 'language': language} for r in segments]}
        self.patches = [patch.object(gateway_module, 'text_task', text_task),
                        patch.object(feishu_docs, 'Client', lambda *args: self.docs),
                        patch.object(aiohttp.ClientSession, '_request',
                                     side_effect=AssertionError('network is forbidden in these tests'))]
        for item in self.patches:
            item.start()
        self.server = None

    async def asyncTearDown(self):
        if self.server:
            await self.server.close()
        for item in reversed(self.patches):
            item.stop()
        self.folder.cleanup()

    def recording(self, ident, segments, frames=50, audio=True, **extra):
        path = self.data / ident
        path.mkdir()
        if audio:
            clean_wav(path / 'audio.wav', frames)
        result = {'status': 'completed', 'durationMs': frames * 20, 'frames': frames, 'sourceType': 'live_device',
                  'language': 'zh', 'automaticDocument': True, 'segments': segments, 'liveModel': 'stepfun'}
        result.update(extra)
        write_json(path / 'result.json', result)
        return path

    def job(self, ident, **values):
        job = {'id': 'j1', 'status': 'pending', 'taskId': 't1', 'durationMs': 1000, 'language': 'zh',
               'provider': 'stepfun', 'autoApply': True, 'capability': 'c' * 43}
        job.update(values)
        write_json(self.data / ident / 'speaker-job.json', job)

    async def boot(self, documents=True):
        self.gateway = Gateway(self.data, self.dir / 'token', 'http://127.0.0.1:1', app_secret_file=self.secret,
                               documents_config=self.config if documents else None)
        self.server = TestServer(self.gateway.application())
        await self.server.start_server()
        return self.gateway

    async def settle(self):
        for _ in range(5):
            tasks = list(self.gateway.speaker_tasks.values())
            if self.gateway.documents:
                tasks += list(self.gateway.documents.tasks.values())
            if not tasks:
                return
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(0)

    def document_text(self):
        return [feishu_docs.block_text(block)[1] for block in self.docs.blocks]


class StartupSweepTests(RestartCase):
    async def test_restart_during_a_pending_file_job_waits_for_the_file_transcript(self):
        self.recording('rec', STREAM, fileModel='stepfun')
        self.job('rec')
        gate = asyncio.Event()
        async def query(http, task):
            await gate.wait()
            return {'status': 'SUCCEEDED'}
        with patch.object(gateway_module.file_asr, 'query', query), \
                patch.object(gateway_module.file_asr, 'parse_result', lambda *args: [dict(row) for row in FILE]):
            await self.boot()
            await asyncio.sleep(0.01)
            self.assertIsNone(self.gateway.documents.load('rec'))   # not from the realtime text
            gate.set()
            await self.settle()
        self.assertEqual(self.gateway.speaker_job('rec')['status'], 'applied')
        self.assertIn('文件转写的完整文字', self.document_text())
        self.assertNotIn('实时字幕的文字', self.document_text())
        self.assertFalse(self.gateway.record('rec')['documentJob']['stale'])

    async def test_restart_never_documents_a_recording_whose_live_text_was_abandoned(self):
        self.recording('deg', STREAM, transcriptionDegraded=True)
        await self.boot()
        await self.settle()
        self.assertIsNone(self.gateway.documents.load('deg'))

    async def test_restart_documents_the_realtime_text_once_no_file_transcript_can_come(self):
        self.recording('refused', STREAM, fileModel='stepfun', fileJobError='这段音频超过文件识别的 99 MB 上限')
        await self.boot()
        await self.settle()
        self.assertEqual(self.gateway.documents.load('refused')['status'], 'ready')
        self.assertIn('实时字幕的文字', self.document_text())

    async def test_restart_resumes_an_automatic_application_cut_short(self):
        self.recording('post', [], fileModel='stepfun', liveModel='none')
        self.job('post', status='ready', segments=FILE, segmentCount=1, speakerCount=1)
        await self.boot()
        await self.settle()
        job = self.gateway.speaker_job('post')
        self.assertEqual(job['status'], 'applied')
        self.assertTrue(job['appliedAutomatically'])
        self.assertEqual(self.gateway.record('post')['segments'][0]['translation'], 'T')
        self.assertIn('文件转写的完整文字', self.document_text())

    async def test_page_polling_also_resumes_a_ready_automatic_job(self):
        self.recording('post', [], fileModel='stepfun', liveModel='none')
        await self.boot(documents=False)
        self.job('post', status='ready', segments=FILE)       # e.g. left by an older process
        response = await self.gateway.get_speakers(SimpleNamespace(match_info={'id': 'post'}))
        self.assertEqual(json.loads(response.text)['job']['status'], 'ready')
        await self.settle()
        self.assertEqual(self.gateway.speaker_job('post')['status'], 'applied')

    async def test_a_pending_file_job_is_created_at_the_next_start(self):
        self.recording('cut', STREAM, status='interrupted', fileModel='stepfun', fileJobPending=True)
        submit = AsyncMock(return_value='provider-task')
        gate = asyncio.Event()
        async def query(http, task):
            await gate.wait()
            return {'status': 'RUNNING'}
        with patch.object(gateway_module.file_asr, 'submit', submit), patch.object(gateway_module.file_asr, 'query', query):
            await self.boot()
            await asyncio.sleep(0.01)
            job = self.gateway.speaker_job('cut')
            self.assertTrue(job['autoApply'])
            self.assertEqual(job['status'], 'pending')
            submit.assert_awaited_once()
            result = json.loads((self.data / 'cut' / 'result.json').read_text())
            self.assertNotIn('fileJobPending', result)

    async def test_one_broken_recording_never_blocks_startup_or_the_list(self):
        self.recording('good', STREAM)
        self.recording('no-audio', STREAM, audio=False)
        (self.data / 'corrupt').mkdir()
        (self.data / 'corrupt' / 'result.json').write_text('{not json')
        self.recording('bad-job', STREAM, fileModel='stepfun')
        (self.data / 'bad-job' / 'speaker-job.json').write_text('[')
        await self.boot()
        await self.settle()
        self.assertEqual(self.gateway.documents.load('good')['status'], 'ready')
        response = await self.gateway.list_records(SimpleNamespace())
        listed = {row['id'] for row in json.loads(response.text)['recordings']}
        self.assertIn('good', listed)
        self.assertNotIn('corrupt', listed)


class AutomaticJobErrorTests(RestartCase):
    async def run_job(self, ident, query, submitting=False, submit=None):
        with patch.object(gateway_module.file_asr, 'query', query), \
                patch.object(gateway_module.file_asr, 'submit', submit or AsyncMock(return_value='t1')), \
                patch.object(gateway_module.asyncio, 'sleep', AsyncMock(return_value=None)):
            await self.gateway.run_speaker_job(ident, submitting)
        await self.settle()

    async def test_an_unusable_automatic_result_documents_the_realtime_text(self):
        self.recording('rec', STREAM, fileModel='stepfun', automaticDocument=False)
        await self.boot()
        self.job('rec')
        async def query(http, task):   # succeeded, but without the speaker labels we require
            return {'status': 'SUCCEEDED', 'result': [{'utterances': [{'text': 'x', 'start_time': 0, 'end_time': 10}]}]}
        await self.run_job('rec', query)
        self.assertEqual(self.gateway.speaker_job('rec')['status'], 'failed')
        self.assertEqual(self.gateway.documents.load('rec')['status'], 'ready')
        self.assertIn('实时字幕的文字', self.document_text())

    async def test_an_unconfirmed_automatic_submit_documents_the_realtime_text(self):
        self.recording('rec', STREAM, fileModel='stepfun', automaticDocument=False)
        await self.boot()
        self.job('rec', status='submitting', taskId=None)
        await self.run_job('rec', AsyncMock(), submitting=True, submit=AsyncMock(side_effect=asyncio.TimeoutError))
        self.assertEqual(self.gateway.speaker_job('rec')['status'], 'uncertain')
        self.assertEqual(self.gateway.documents.load('rec')['status'], 'ready')

    async def test_transient_query_errors_are_retried_by_the_worker(self):
        self.recording('rec', [], fileModel='stepfun', liveModel='none', automaticDocument=False)
        await self.boot(documents=False)
        self.job('rec')
        answers = [asyncio.TimeoutError(), aiohttp.ServerDisconnectedError(), {'status': 'RUNNING'}, {'status': 'SUCCEEDED'}]
        async def query(http, task):
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        with patch.object(gateway_module.file_asr, 'parse_result', lambda *args: [dict(row) for row in FILE]):
            await self.run_job('rec', query)
        self.assertEqual(answers, [])
        self.assertEqual(self.gateway.speaker_job('rec')['status'], 'applied')


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    """The real runner sequence, on a loopback socket, with a client that answers
    pings like a browser. Constants are the production ones."""

    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)
        self.gateway = Gateway(self.dir / 'records', self.dir / 'token', 'http://127.0.0.1:1')
        self.providers = []
        def create(http, language, emit):
            provider = ControlledStream(http, language, emit)
            async def finish():
                provider.finish_calls += 1
                await asyncio.Event().wait()   # a provider that never settles the last sentence
            provider.finish = finish
            self.providers.append(provider)
            return provider
        self.patches = [patch.object(gateway_module, 'OpusDecoder', SyntheticDecoder),
                        patch.object(gateway_module, 'StepStream', create)]
        for item in self.patches:
            item.start()
        self.runner = web.AppRunner(self.gateway.application(), handler_cancellation=True,
                                    shutdown_timeout=gateway_module.SHUTDOWN_TIMEOUT)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.gateway.origin = 'http://127.0.0.1:%d' % port
        self.http = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
        headers = {'Origin': self.gateway.origin}
        response = await self.http.post(self.gateway.origin + '/api/session', json={'token': self.gateway.token},
                                        headers=headers)
        self.assertEqual(response.status, 200)
        self.ws = await self.http.ws_connect(self.gateway.origin + '/api/stream', headers=headers)
        self.messages = []
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        async for message in self.ws:   # answers pings and the close handshake, as a browser does
            if message.type == aiohttp.WSMsgType.TEXT:
                self.messages.append(json.loads(message.data))

    async def asyncTearDown(self):
        await self.http.close()
        for item in self.patches:
            item.stop()
        self.folder.cleanup()

    async def wait_for(self, condition, timeout=2):
        deadline = time.monotonic() + timeout
        while not condition():
            self.assertLess(time.monotonic(), deadline)
            await asyncio.sleep(0.01)

    async def record(self, frames, stop=False):
        await self.ws.send_json({'type': 'start', 'recordingId': 'live', 'title': '停服测试',
                                 'sourceType': 'live_device', 'language': 'zh', 'fileModel': 'stepfun'})
        await self.wait_for(lambda: any(m['type'] == 'ready' for m in self.messages))
        for sequence in range(frames):
            await self.ws.send_bytes(struct.pack('<I', sequence) + bytes([sequence % 255]) * 160)
        await self.wait_for(lambda: sum(m['type'] == 'ack' for m in self.messages) == frames)
        if stop:
            await self.ws.send_json({'type': 'stop'})
            await self.wait_for(lambda: self.providers and self.providers[0].finish_calls == 1)

    def result(self):
        return json.loads((self.gateway.data / 'live' / 'result.json').read_text())

    async def stop_service(self):
        started = time.monotonic()
        await self.runner.cleanup()
        return time.monotonic() - started

    async def test_stop_during_recording_saves_cleanly_well_inside_the_unit_budget(self):
        await self.record(25)
        submitting = asyncio.Event()
        async def never_returns(*args):
            submitting.set()
            await asyncio.Event().wait()
        # A second recording's file submit is in flight: it gets a short drain, then cancelled.
        other = self.gateway.data / 'other'
        other.mkdir()
        write_json(other / 'speaker-job.json', {'id': 'j', 'status': 'submitting', 'capability': 'c' * 43})
        with patch.object(gateway_module.file_asr, 'submit', never_returns):
            self.gateway.launch_speaker_worker('other', submitting=True)
            await asyncio.wait_for(submitting.wait(), 1)
            elapsed = await self.stop_service()
        await asyncio.wait_for(self.reader, 1)
        self.assertLess(elapsed, 15)                                  # TimeoutStopSec in the unit
        self.assertLess(elapsed, gateway_module.SHUTDOWN_TASK_SECONDS + 3)
        self.assertEqual(self.ws.close_code, 1001)
        result = self.result()
        self.assertEqual(result['status'], 'interrupted')
        self.assertEqual(result['frames'], 25)
        self.assertEqual(clean_wav_bytes(self.gateway.data / 'live' / 'audio.wav'), 25 * 640)   # header patched
        self.assertTrue(result['fileJobPending'])        # created at the next start, never mid-stop
        self.assertIsNone(self.gateway.speaker_job('live'))
        self.assertFalse(self.gateway.speaker_tasks)
        self.assertEqual(self.gateway.speaker_job('other')['status'], 'submitting')   # uncertain after restart
        self.assertEqual(self.providers[0].close_calls, 1)

    async def test_stop_while_an_accepted_stop_is_finishing_is_bounded(self):
        await self.record(10, stop=True)
        elapsed = await self.stop_service()
        self.assertLess(elapsed, 15)
        self.assertLess(elapsed, gateway_module.SHUTDOWN_FINISH_SECONDS + 3)
        result = self.result()
        self.assertEqual(result['status'], 'interrupted')
        self.assertTrue(result['finishTimedOut'])
        self.assertEqual(clean_wav_bytes(self.gateway.data / 'live' / 'audio.wav'), 10 * 640)
        self.assertFalse(self.gateway.active)

    def test_the_whole_stop_budget_fits_the_unit(self):
        worst = (max(gateway_module.SHUTDOWN_STREAM_SECONDS, gateway_module.SHUTDOWN_TASK_SECONDS) + 1 +
                 2 * gateway_module.SHUTDOWN_TIMEOUT)
        self.assertLess(gateway_module.SHUTDOWN_FINISH_SECONDS + gateway_module.SHUTDOWN_PROVIDER_CLOSE_SECONDS,
                        gateway_module.SHUTDOWN_STREAM_SECONDS)
        self.assertLessEqual(worst, 12)   # leaves margin inside TimeoutStopSec=15


if __name__ == '__main__':
    unittest.main()
