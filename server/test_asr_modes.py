"""Realtime / post modes and the four models; no real credentials or paid API."""
import asyncio
import gzip
import json
import struct
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import gateway as gateway_module
import volc
from test_stream_reliability import ControlledStream, GatewayReliabilityTests, SyntheticDecoder


def server_frame(value, last=False, sequence=1):
    body = gzip.compress(json.dumps(value).encode())
    flags = 0b0011 if last else 0b0001
    return bytes([0x11, (0b1001 << 4) | flags, 0x11, 0]) + struct.pack('>i', sequence) + struct.pack('>I', len(body)) + body


class VolcProtocolTests(unittest.TestCase):
    def test_client_frames_carry_sequence_and_gzip_payload(self):
        value = volc.frame(volc.AUDIO_REQUEST, 0b0011, volc.RAW, b'\x01\x02', -7)
        self.assertEqual(value[:4], bytes([0x11, 0x23, 0x01, 0]))
        self.assertEqual(struct.unpack('>i', value[4:8])[0], -7)
        size = struct.unpack('>I', value[8:12])[0]
        self.assertEqual(gzip.decompress(value[12:12 + size]), b'\x01\x02')

    def test_server_frames_and_errors_are_parsed(self):
        kind, sequence, last, value = volc.parse_frame(server_frame({'result': {'text': '好'}}, last=True, sequence=9))
        self.assertEqual((kind, sequence, last, value['result']['text']), ('result', 9, True, '好'))
        error = bytes([0x11, 0xF0, 0x10, 0]) + struct.pack('>I', 45000030) + struct.pack('>I', 2) + b'no'
        self.assertEqual(volc.parse_frame(error)[0::3], ('error', 45000030))
        with self.assertRaises(ValueError):
            volc.parse_frame(b'\x11')

    def test_transcript_rows_follow_utterances_and_settle_on_definite(self):
        transcript = volc.VolcTranscript('zh')
        first = transcript.apply({'result': {'utterances': [{'text': '你好', 'start_time': 100, 'end_time': 600, 'definite': False}]}})
        self.assertEqual([(c['segmentId'], c['text'], c['final']) for c in first], [('volc-0', '你好', False)])
        again = transcript.apply({'result': {'utterances': [{'text': '你好', 'start_time': 100, 'end_time': 600, 'definite': False}]}})
        self.assertEqual(again, [])
        settled = transcript.apply({'result': {'utterances': [
            {'text': '你好呀。', 'start_time': 100, 'end_time': 900, 'definite': True},
            {'text': '第二句', 'start_time': 1200, 'end_time': 1500, 'definite': False}]}})
        self.assertEqual([(c['segmentId'], c['final']) for c in settled], [('volc-0', True), ('volc-1', False)])
        # A settled sentence never changes again.
        self.assertEqual(transcript.apply({'result': {'utterances': [{'text': '改了', 'definite': True}]}}), [])
        transcript.finalize()
        rows = transcript.segments()
        self.assertEqual([(r['source'], r['startMs'], r['endMs'], r['sourceFinal']) for r in rows],
                         [('你好呀。', 100, 900, True), ('第二句', 1200, 1500, True)])

    def test_the_first_utterance_without_a_start_time_starts_with_the_audio(self):
        # Doubao's raw stream for a real recording (2026-11-04): the first
        # utterance carries end_time only, while it grows and once definite.
        transcript = volc.VolcTranscript('zh')
        growing = transcript.apply({'result': {'utterances': [{'text': '现在', 'end_time': 500, 'definite': False}]}})
        self.assertEqual((growing[0]['startMs'], growing[0]['endMs']), (0, 500))
        transcript.apply({'result': {'utterances': [
            {'text': '现在有一个问题，就是', 'end_time': 10632, 'definite': True},
            {'text': '啊，最后一个环节了，', 'start_time': 11632, 'end_time': 16732, 'definite': True},
            {'text': '暂停', 'end_time': 18000, 'definite': True}]}})
        self.assertEqual([(r['startMs'], r['endMs']) for r in transcript.segments()],
                         [(0, 10632), (11632, 16732), (16732, 18000)])

    def test_long_sessions_keep_utterances_far_past_the_old_cap(self):
        transcript = volc.VolcTranscript('zh')
        utterances = [{'text': '第%d句' % i, 'start_time': i * 10, 'end_time': i * 10 + 5, 'definite': True}
                      for i in range(2500)]
        self.assertEqual(len(transcript.apply({'result': {'utterances': utterances}})), 2500)
        self.assertEqual(transcript.settled, 2500)     # finished rows are not walked again
        utterances.append({'text': '还在说', 'start_time': 25000, 'end_time': 25005, 'definite': False})
        self.assertEqual([c['text'] for c in transcript.apply({'result': {'utterances': utterances}})], ['还在说'])
        utterances[-1] = {'text': '还在说完了。', 'start_time': 25000, 'end_time': 25009, 'definite': True}
        self.assertEqual([(c['text'], c['final']) for c in transcript.apply({'result': {'utterances': utterances}})],
                         [('还在说完了。', True)])
        self.assertEqual(len(transcript.segments()), 2501)
        self.assertGreaterEqual(volc.MAX_UTTERANCES, 20000)
        with patch.object(volc, 'MAX_UTTERANCES', 2600):   # the bound still holds memory
            more = utterances + [{'text': 'x%d' % i, 'definite': True, 'start_time': 0, 'end_time': 1} for i in range(500)]
            transcript.apply({'result': {'utterances': more}})
        self.assertEqual(len(transcript.rows), 2600)

    def test_an_oversized_provider_response_is_refused_before_it_is_expanded(self):
        frame = server_frame({'result': {'text': '好' * 4000}})
        self.assertEqual(len(volc.parse_frame(frame)[3]['result']['text']), 4000)
        with patch.object(volc, 'MAX_RESPONSE_BYTES', 1000):
            with self.assertRaisesRegex(ValueError, 'larger than allowed'):
                volc.parse_frame(frame)

    def test_file_result_keeps_provider_speakers_or_a_single_unnamed_one(self):
        rows = volc.file_parse({'result': {'utterances': [
            {'text': '甲说', 'start_time': 0, 'end_time': 800, 'additions': {'speaker': '1'}},
            {'text': '乙说', 'start_time': 900, 'end_time': 1500, 'additions': {'speaker': '2'}},
            {'text': '甲又说', 'start_time': 1600, 'end_time': 1900, 'additions': {'speaker': '1'}}]}}, 2000, 'j', 'zh')
        self.assertEqual([r['speaker'] for r in rows], ['发言人 1', '发言人 2', '发言人 1'])
        plain = volc.file_parse({'result': {'utterances': [{'text': '一个人', 'start_time': 0, 'end_time': 500}]}}, 1000, 'k')
        self.assertEqual(plain[0]['speaker'], '发言人')
        with self.assertRaises(ValueError):
            volc.file_parse({'result': {'utterances': [{'text': '超出', 'start_time': 5000, 'end_time': 6000}]}}, 1000, 'x')

    def test_sentence_language_is_detected_for_mixed_talk(self):
        self.assertEqual(volc.text_language('我在用 Cloud Code'), 'zh')
        self.assertEqual(volc.text_language('Tomorrow at 3 p.m.'), 'en')
        self.assertEqual(volc.text_language('123。', 'en'), 'en')
        transcript = volc.VolcTranscript('zh')
        caption = transcript.apply({'result': {'utterances': [{'text': 'This is English.', 'start_time': 0, 'end_time': 900, 'definite': True}]}})[0]
        self.assertEqual(caption['language'], 'en')
        self.assertEqual((transcript.rows[0]['sourceLanguage'], transcript.rows[0]['translationLanguage']), ('en', 'zh'))

    def test_credentials_need_app_and_private_token(self):
        with patch.dict('os.environ', {'VOLC_ASR_APP_ID': '', 'VOLC_ASR_TOKEN': '', 'VOLC_ASR_TOKEN_FILE': ''}):
            self.assertFalse(volc.configured())
        with patch.dict('os.environ', {'VOLC_ASR_APP_ID': '1', 'VOLC_ASR_TOKEN': 'synthetic'}):
            self.assertTrue(volc.configured())


class ModeStreamTests(GatewayReliabilityTests):
    """Reuses the in-memory phone; only the mode-specific behaviour is new here."""

    async def start_mode(self, live, file_model, configured=True):
        self.stack.enter_context(patch.object(gateway_module.volc, 'configured', return_value=configured))
        self.created = []
        def create(kind):
            def make(http, language, emit):
                self.provider = ControlledStream(http, language, emit)
                self.created.append(kind)
                return self.provider
            return make
        self.stack.enter_context(patch.object(gateway_module, 'StepStream', create('stepfun')))
        self.stack.enter_context(patch.object(gateway_module, 'VolcStream', create('doubao')))
        self.jobs = []
        async def fake_job(ident, provider='stepfun', auto=False):
            self.jobs.append((ident, provider, auto))
            return {'status': 'submitting'}
        self.stack.enter_context(patch.object(self.gateway, 'create_speaker_job', fake_job))
        self.stream_task = asyncio.create_task(self.gateway.stream(SimpleNamespace(headers={'Origin': self.gateway.origin})))
        start = {'type': 'start', 'recordingId': 'record-one', 'title': '模式测试', 'sourceType': 'live_device', 'language': 'zh',
                 'liveModel': live}
        if file_model:
            start['fileModel'] = file_model
        self.phone.text(start)

    async def test_post_mode_records_audio_only_and_queues_the_file_job(self):
        await self.start_mode('none', 'stepfun')
        await self.phone.receive_type('ready')
        for sequence in range(3):
            self.phone.audio(sequence)
        status = await self.wait_for_phase('recording')
        self.assertIn('录完后识别全文', status['message'])
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.created, [])                       # no realtime provider at all
        self.assertEqual(complete['segments'], [])
        self.assertEqual(complete['fileModel'], 'stepfun')
        self.assertEqual(self.result()['status'], 'completed')
        self.assertEqual(self.saved_frames(), 3)
        self.assertEqual(self.jobs, [('record-one', 'stepfun', True)])

    async def test_doubao_live_mode_uses_the_doubao_stream_and_a_file_model(self):
        await self.start_mode('doubao', 'doubao')
        await self.phone.receive_type('ready')
        self.phone.audio(0)
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.created, ['doubao'])
        self.assertEqual(self.result()['provider'], '豆包')
        self.assertEqual(self.jobs, [('record-one', 'doubao', True)])

    async def test_doubao_closing_after_its_final_result_still_completes(self):
        await self.start_mode('doubao', 'stepfun')
        await self.phone.receive_type('ready')
        provider = self.provider
        async def finish():
            # Doubao closes its upstream right after the final package, while
            # the gateway still has work (translations) before saving.
            provider.stopped.set()
            await asyncio.sleep(0.05)
            return provider.transcript.segments()
        provider.finish = finish
        self.phone.audio(0)
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.result()['status'], 'completed')
        self.assertNotIn('error', self.result())

    async def test_invalid_mode_combinations_are_rejected_before_recording(self):
        await self.start_mode('none', None)
        error = await self.phone.receive_type('error')
        self.assertIn('Invalid recording initialization', error['message'])

    async def test_doubao_is_refused_when_not_configured(self):
        await self.start_mode('doubao', None, configured=False)
        error = await self.phone.receive_type('error')
        self.assertIn('豆包识别尚未配置', error['message'])


class AutomaticFileJobTests(GatewayReliabilityTests):
    async def test_a_ready_file_transcript_is_applied_translated_and_documented(self):
        await self.start()
        for sequence in range(3):
            self.phone.audio(sequence)
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        ident = 'record-one'
        job = {'id': 'j1', 'status': 'pending', 'taskId': 't1', 'durationMs': 60, 'language': 'zh',
               'provider': 'stepfun', 'autoApply': True, 'capability': 'c' * 43}
        self.gateway.save_speaker_job(ident, job)
        async def query(http, task):
            return {'status': 'SUCCEEDED'}
        def parse(value, duration_ms, job_id, language='zh'):
            return [{'id': 'file-j1-0', 'source': '甲的话', 'sourceLanguage': 'zh', 'sourceRevision': 0, 'sourceFinal': True,
                     'startMs': 0, 'endMs': 40, 'speaker': '发言人 1', 'providerSpeakerId': 'a'}]
        async def translate(http, task, segments, language='en'):
            return {'translations': [{'id': row['id'], 'text': 'A says', 'language': language} for row in segments]}
        enqueued = []
        class Documents:
            async def enqueue(self, record, retry=False):
                enqueued.append([row['source'] for row in record['segments']])
            def public(self, ident, record=None):
                return {'status': 'idle'}
            async def close(self):
                pass
        self.gateway.documents = Documents()
        with patch.object(gateway_module.file_asr, 'query', query), patch.object(gateway_module.file_asr, 'parse_result', parse), \
                patch.object(gateway_module, 'text_task', translate), patch.object(gateway_module.asyncio, 'sleep', return_value=None):
            await self.gateway.run_speaker_job(ident)
        saved = self.gateway.speaker_job(ident)
        self.assertEqual(saved['status'], 'applied')
        self.assertTrue(saved['appliedAutomatically'])
        record = self.gateway.record(ident)
        self.assertTrue(record['speakerDiarization'])
        self.assertEqual([(r['source'], r['speaker'], r['translation']) for r in record['segments']], [('甲的话', '发言人 1', 'A says')])
        self.assertEqual(enqueued, [['甲的话']])
        self.assertTrue((self.path / 'records' / ident / 'versions' / 'before-speakers-j1.json').is_file())

    async def test_a_failed_automatic_job_still_documents_the_realtime_text(self):
        await self.start(configure=lambda provider: setattr(provider, 'partial_caption', True))
        self.phone.audio(0)
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.gateway.save_speaker_job('record-one', {'id': 'j2', 'status': 'pending', 'taskId': 't2', 'durationMs': 20,
                                                     'language': 'zh', 'provider': 'stepfun', 'autoApply': True})
        enqueued = []
        class Documents:
            async def enqueue(self, record, retry=False):
                enqueued.append(len(record['segments']))
            def public(self, ident, record=None):
                return {'status': 'idle'}
            async def close(self):
                pass
        self.gateway.documents = Documents()
        async def query(http, task):
            return {'status': 'FAILED'}
        with patch.object(gateway_module.file_asr, 'query', query):
            await self.gateway.run_speaker_job('record-one')
        self.assertEqual(self.gateway.speaker_job('record-one')['status'], 'failed')
        self.assertEqual(enqueued, [1])


# The base class is only a fixture here; its own tests run from their module.
for _name in [name for name in dir(GatewayReliabilityTests) if name.startswith('test_')]:
    setattr(ModeStreamTests, _name, None)
    setattr(AutomaticFileJobTests, _name, None)
del GatewayReliabilityTests

if __name__ == '__main__':
    unittest.main()
