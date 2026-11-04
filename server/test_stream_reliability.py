"""In-memory phone/provider failures; no real device, credentials or paid API."""
import asyncio
import copy
import json
import struct
import unittest
import uuid
import wave
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import aiohttp
import gateway as gateway_module
from gateway import Gateway, source_identity, write_json
from stepfun import StepStream, Transcript

WORK = Path(__file__).resolve().parents[1] / 'work' / 'tests' / 'test_stream_reliability'


def identity_message(first_sequence=7):
    return {'type': 'source_identity', 'recordingId': 'record-one', 'identity': {
        'schemaVersion': 1, 'protocol': 'soundcore-d3200', 'fileId': 123456,
        'jsapiDeviceId': 'synthetic-private-device-id', 'sourceType': 'live_device_recording',
        'firstSequence': first_sequence, 'firstReceivedAtMs': 1793318400000, 'headerIdMatched': True}}


class MemoryPhone:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()
        self.sent = []
        self.closed = False
        self.received_audio = 0

    async def prepare(self, request):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.incoming.get()
        if value is None:
            self.closed = True
            raise StopAsyncIteration
        if value.type == aiohttp.WSMsgType.BINARY:
            self.received_audio += 1
        return value

    def text(self, value):
        self.incoming.put_nowait(SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(value)))

    def audio(self, sequence):
        self.incoming.put_nowait(SimpleNamespace(type=aiohttp.WSMsgType.BINARY,
            data=struct.pack('<I', sequence) + bytes([sequence % 255]) * 160))

    def disconnect(self):
        self.incoming.put_nowait(None)

    async def send_json(self, value):
        if self.closed:
            raise ConnectionResetError('Synthetic phone disconnected')
        value = copy.deepcopy(value)
        self.sent.append(value)
        self.outgoing.put_nowait(value)

    async def receive_type(self, kind, timeout=0.5):
        async def read():
            while True:
                value = await self.outgoing.get()
                if value['type'] == kind:
                    return value
        return await asyncio.wait_for(read(), timeout)

    async def close(self, **kwargs):
        self.closed = True
        self.disconnect()


class SyntheticDecoder:
    instances = []

    def __init__(self):
        self.closed = False
        self.instances.append(self)

    def decode(self, packet):
        if len(packet) != 160:
            raise ValueError('Invalid synthetic packet')
        return struct.pack('<320h', *([packet[0] * 10] * 320))

    def close(self):
        self.closed = True


class ControlledStream:
    def __init__(self, http, language, emit):
        self.emit = emit
        self.transcript = Transcript(language)
        self.ws = None
        self.stopped = asyncio.Event()
        self.open_entered = asyncio.Event()
        self.append_entered = asyncio.Event()
        self.release = asyncio.Event()
        self.block_open = False
        self.block_append = False
        self.append_error = False
        self.partial_caption = False
        self.open_calls = self.close_calls = self.finish_calls = 0
        self.appended = []
        self.failure = None

    async def open(self):
        self.open_calls += 1
        self.ws = True
        if self.partial_caption:
            caption = self.transcript.apply({'type': 'conversation.item.input_audio_transcription.delta',
                                            'item_id': 'partial-one', 'text': '已收到的文字', 'stash': ''})
            await self.emit(caption)
        self.open_entered.set()
        if self.block_open:
            await self.release.wait()

    async def append(self, pcm):
        self.appended.append(bytes(pcm))
        self.append_entered.set()
        if self.append_error:
            raise RuntimeError('Synthetic upstream append failed')
        if self.block_append:
            await self.release.wait()

    async def finish(self):
        self.finish_calls += 1
        return self.transcript.segments()

    def check(self):
        if self.failure:
            raise RuntimeError(self.failure)

    async def close(self):
        self.close_calls += 1


class MemoryProviderSocket:
    def __init__(self, handshake=True):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.closed = False
        if handshake:
            self.event({'type': 'session.created'})

    def event(self, event):
        self.incoming.put_nowait(SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(event)))

    def disconnect(self):
        self.incoming.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.incoming.get()
        if value is None:
            raise StopAsyncIteration
        return value

    async def send_json(self, value):
        self.sent.append(value)
        if value['type'] == 'session.update':
            self.event({'type': 'session.updated'})

    async def close(self):
        self.closed = True
        self.disconnect()


class MemoryProviderHTTP:
    def __init__(self, socket):
        self.socket = socket
        self.connections = 0

    async def ws_connect(self, *args, **kwargs):
        self.connections += 1
        return self.socket


class GatewayReliabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.path = WORK / uuid.uuid4().hex
        self.gateway = Gateway(self.path / 'records', self.path / 'token', 'https://synthetic.invalid')
        self.phone = MemoryPhone()
        self.provider = None
        self.stream_task = None
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(gateway_module.web, 'WebSocketResponse', return_value=self.phone))
        self.stack.enter_context(patch.object(gateway_module, 'OpusDecoder', SyntheticDecoder))
        self.stack.enter_context(patch('stepfun.credential', return_value='synthetic-no-real-key'))
        self.stack.enter_context(patch.object(aiohttp.ClientSession, 'ws_connect',
            side_effect=AssertionError('Real provider connection forbidden in synthetic tests')))

    async def asyncTearDown(self):
        if self.stream_task and not self.stream_task.done():
            self.phone.disconnect()
            try:
                await asyncio.wait_for(asyncio.shield(self.stream_task), 0.5)
            except asyncio.TimeoutError:
                self.stream_task.cancel()
                await asyncio.gather(self.stream_task, return_exceptions=True)
        self.stack.close()

    async def start(self, configure=None, real_provider=False, **extra):
        if not real_provider:
            def create(http, language, emit):
                self.provider = ControlledStream(http, language, emit)
                if configure:
                    configure(self.provider)
                return self.provider
            self.stack.enter_context(patch.object(gateway_module, 'StepStream', create))
        self.stream_task = asyncio.create_task(self.gateway.stream(SimpleNamespace(
            headers={'Origin': self.gateway.origin})))
        self.phone.text({'type': 'start', 'recordingId': 'record-one', 'title': '合成中断测试',
                         'sourceType': 'live_device', 'language': 'zh', **extra})
        return await self.phone.receive_type('ready')

    def result(self):
        return json.loads((self.path / 'records/record-one/result.json').read_text())

    def acked(self):
        return [event['sequence'] for event in self.phone.sent if event['type'] == 'ack']

    async def until(self, condition, timeout=0.5):
        async def poll():
            while not condition():
                await asyncio.sleep(0.005)
        await asyncio.wait_for(poll(), timeout)

    def saved_frames(self):
        with wave.open(str(self.path / 'records/record-one/audio.wav'), 'rb') as audio:
            return audio.getnframes() // 320

    async def test_disconnect_during_upstream_open_retains_every_received_frame_and_caption(self):
        def configure(provider):
            provider.block_open = provider.partial_caption = True
        await self.start(configure)
        for sequence in range(12):
            self.phone.audio(sequence)
        await asyncio.wait_for(self.provider.open_entered.wait(), 0.5)
        self.phone.disconnect()
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.saved_frames(), 12)
        self.assertEqual(self.result()['frames'], 12)
        self.assertEqual(self.result()['status'], 'interrupted')
        self.assertEqual(self.result()['segments'][0]['source'], '已收到的文字')
        self.assertFalse(self.result()['segments'][0]['sourceFinal'])
        self.assertEqual(self.provider.open_calls, 1)
        self.assertEqual(self.provider.finish_calls, 0)
        self.assertEqual(self.provider.close_calls, 1)
        self.assertFalse(self.gateway.active)
        self.assertFalse(any(event['type'] == 'complete' for event in self.phone.sent))

    async def test_disconnect_during_upstream_append_retains_queued_audio(self):
        await self.start(lambda provider: setattr(provider, 'block_append', True))
        for sequence in range(18):
            self.phone.audio(sequence)
        await asyncio.wait_for(self.provider.append_entered.wait(), 0.5)
        self.phone.disconnect()
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.saved_frames(), 18)
        self.assertEqual(self.result()['status'], 'interrupted')
        self.assertEqual(self.provider.open_calls, 1)

    async def test_explicit_stop_flush_failure_preserves_audio_and_is_not_complete(self):
        await self.start()
        for sequence in range(6):
            self.phone.audio(sequence)
        while (await self.phone.receive_type('ack'))['sequence'] != 5:
            pass
        self.provider.append_error = True
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('error')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.saved_frames(), 6)
        self.assertEqual(self.result()['status'], 'failed')
        self.assertEqual(self.provider.open_calls, 1)
        self.assertEqual(self.provider.finish_calls, 0)
        self.assertFalse(any(event['type'] == 'complete' for event in self.phone.sent))

    async def test_upstream_error_while_phone_idle_fails_without_waiting_for_next_frame(self):
        remote = MemoryProviderSocket()
        self.gateway.http = MemoryProviderHTTP(remote)
        await self.start(real_provider=True)
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        await self.wait_for_phase('recording')   # acks no longer wait for the provider
        remote.event({'type': 'conversation.item.input_audio_transcription.delta',
                      'item_id': 'retained', 'text': '上游已收到', 'stash': ''})
        await self.phone.receive_type('caption')
        remote.event({'type': 'error', 'error': {'code': 'synthetic_quota'}})
        error = await self.phone.receive_type('error', timeout=0.25)
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertIn('synthetic_quota', error['message'])
        self.assertEqual(self.result()['status'], 'failed')
        self.assertEqual(self.result()['segments'][0]['source'], '上游已收到')
        self.assertEqual(self.saved_frames(), 1)
        self.assertEqual(self.gateway.http.connections, 1)
        self.assertTrue(remote.closed)

    async def test_upstream_eof_while_phone_idle_releases_recording_slot(self):
        remote = MemoryProviderSocket()
        self.gateway.http = MemoryProviderHTTP(remote)
        await self.start(real_provider=True)
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        remote.disconnect()
        error = await self.phone.receive_type('error', timeout=0.25)
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertIn('closed', error['message'])
        self.assertEqual(self.result()['status'], 'failed')
        self.assertFalse(self.gateway.active)
        self.assertEqual(self.gateway.http.connections, 1)


    async def test_forward_backlog_overflow_degrades_and_keeps_acking_every_saved_frame(self):
        await self.start(lambda provider: setattr(provider, 'block_open', True))
        self.phone.audio(0)
        await asyncio.wait_for(self.provider.open_entered.wait(), 0.5)
        count = gateway_module.FORWARD_QUEUE_FRAMES + 50  # past the provider backlog
        for sequence in range(1, count):
            self.phone.audio(sequence)
        # Every frame is saved and acknowledged while the provider is still stuck.
        await self.until(lambda: len(self.acked()) == count)
        self.assertEqual(self.acked(), list(range(count)))
        self.assertEqual(self.provider.open_calls, 1)
        self.assertFalse(self.provider.appended)  # nothing reached the provider yet
        self.provider.release.set()   # the provider answers late; its transcript is abandoned anyway
        await self.wait_for_phase('transcription_degraded')
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertTrue(complete['transcriptionDegraded'])
        self.assertEqual(self.saved_frames(), count)
        self.assertEqual(self.result()['frames'], count)
        self.assertEqual(self.result()['status'], 'completed')
        self.assertTrue(self.result()['transcriptionDegraded'])
        self.assertEqual(self.provider.open_calls, 1)
        self.assertEqual(self.provider.finish_calls, 0)
        self.assertFalse(any(event['type'] == 'error' for event in self.phone.sent))
        self.assertFalse(self.gateway.active)

    async def test_result_write_failure_still_closes_audio_decoder_phone_and_session_slot(self):
        await self.start()
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        decoder = SyntheticDecoder.instances[-1]
        with patch.object(gateway_module, 'write_json', side_effect=OSError('Synthetic disk failure')):
            self.phone.disconnect()
            with self.assertRaises(OSError):
                await asyncio.wait_for(self.stream_task, 0.5)
        self.assertFalse(self.gateway.active)
        self.assertTrue(self.phone.closed)
        self.assertTrue(decoder.closed)
        self.assertEqual(self.provider.close_calls, 1)
        self.assertEqual(self.saved_frames(), 1)

    async def test_stop_does_not_accept_an_untranscribed_audio_tail(self):
        await self.start()
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        finishing = asyncio.Event()
        async def blocked_finish():
            finishing.set()
            await asyncio.Event().wait()
        self.provider.finish = blocked_finish
        self.phone.text({'type': 'stop'})
        await asyncio.wait_for(finishing.wait(), 0.5)
        self.phone.audio(1)
        error = await self.phone.receive_type('error')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertIn('after stop', error['message'])
        self.assertEqual(self.saved_frames(), 1)
        self.assertEqual(self.result()['status'], 'failed')
        self.assertFalse(any(event['type'] == 'complete' for event in self.phone.sent))

    async def test_draining_queue_preserves_order_and_flushes_the_last_short_chunk_once(self):
        await self.start()
        count = 1211
        for offset in range(0, count, 100):
            end = min(count, offset + 100)
            for sequence in range(offset, end):
                self.phone.audio(sequence)
            while (await self.phone.receive_type('ack'))['sequence'] != end - 1:
                pass
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        expected = b''.join(struct.pack('<320h', *([sequence % 255 * 10] * 320)) for sequence in range(count))
        self.assertEqual(b''.join(self.provider.appended), expected)
        self.assertEqual(len(self.provider.appended[-1]), 640)
        self.assertEqual(self.provider.finish_calls, 1)
        self.assertEqual(self.provider.open_calls, 1)
        self.assertEqual(self.saved_frames(), count)
        self.assertEqual(self.result()['durationMs'], count * 20)
        self.assertEqual(self.result()['status'], 'completed')

    async def test_source_identity_is_idempotent_and_survives_metadata_editing(self):
        await self.start()
        command = identity_message()
        self.phone.text(command)
        self.phone.text(command)
        self.phone.audio(7)
        await self.phone.receive_type('ack')
        self.phone.text(command)
        self.phone.audio(8)
        await self.phone.receive_type('ack')
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        identity = command['identity']
        self.assertEqual(self.result()['status'], 'completed')
        self.assertEqual(self.result()['sourceIdentity'], identity)
        meta_path = self.gateway.data / '_metadata/record-one.json'
        self.assertEqual(json.loads(meta_path.read_text())['sourceIdentity'], identity)
        for incoming in (None, {'fileId': 999, 'jsapiDeviceId': 'spoofed'}, 'omitted'):
            body = {'id': 'record-one', 'title': '改名仍保留来源', 'segments': [], 'nativeAssociation': True}
            if incoming != 'omitted':
                body['sourceIdentity'] = incoming
            async def json_body():
                return body
            await self.gateway.save_record(SimpleNamespace(headers={'Origin': self.gateway.origin}, json=json_body))
            self.assertEqual(json.loads(meta_path.read_text())['sourceIdentity'], identity)
            self.assertEqual(self.gateway.record('record-one')['sourceIdentity'], identity)
            self.assertNotIn('nativeAssociation', self.gateway.record('record-one'))
        # A stale file snapshot cannot override the stream's accepted declaration.
        cached = json.loads(meta_path.read_text())
        cached['sourceIdentity'] = {'fileId': 999}
        write_json(meta_path, cached)
        self.assertEqual(self.gateway.record('record-one')['sourceIdentity'], identity)
        self.assertNotIn(identity['jsapiDeviceId'], json.dumps(self.phone.sent))
        self.assertEqual(self.saved_frames(), 2)

    async def test_old_client_without_identity_remains_compatible_and_reports_null(self):
        await self.start()
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.result()['status'], 'completed')
        self.assertIsNone(self.result()['sourceIdentity'])
        self.assertIsNone(self.gateway.record('record-one')['sourceIdentity'])

    async def test_late_first_identity_is_rejected_without_discarding_earlier_audio(self):
        await self.start()
        self.phone.audio(7)
        await self.phone.receive_type('ack')
        self.phone.text(identity_message())
        error = await self.phone.receive_type('error')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertIn('must precede', error['message'])
        self.assertEqual(self.result()['status'], 'failed')
        self.assertIsNone(self.result()['sourceIdentity'])
        self.assertEqual(self.saved_frames(), 1)

    async def test_changed_identity_is_rejected_and_keeps_the_first_declaration(self):
        await self.start()
        first = identity_message()
        self.phone.text(first)
        self.phone.audio(7)
        await self.phone.receive_type('ack')
        changed = copy.deepcopy(first)
        changed['identity']['fileId'] += 1
        self.phone.text(changed)
        error = await self.phone.receive_type('error')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertIn('cannot change', error['message'])
        self.assertEqual(self.result()['status'], 'failed')
        self.assertEqual(self.result()['sourceIdentity'], first['identity'])
        self.assertEqual(self.saved_frames(), 1)

    async def test_first_sequence_must_match_identity_and_does_not_open_provider_on_mismatch(self):
        await self.start()
        self.phone.text(identity_message())
        self.phone.audio(8)
        error = await self.phone.receive_type('error')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertIn('first audio sequence', error['message'])
        self.assertEqual(self.result()['status'], 'failed')
        self.assertEqual(self.saved_frames(), 0)
        self.assertEqual(self.provider.open_calls, 0)

    async def test_malformed_identity_is_rejected_without_echoing_device_identifier(self):
        await self.start()
        command = identity_message()
        command['identity']['headerIdMatched'] = 1
        self.phone.text(command)
        error = await self.phone.receive_type('error')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(error['message'], 'Invalid source identity declaration')
        self.assertIsNone(self.result()['sourceIdentity'])
        self.assertNotIn(command['identity']['jsapiDeviceId'], json.dumps(self.phone.sent))
        self.assertEqual(self.provider.open_calls, 0)

    async def test_session_limit_finalizes_and_saves_instead_of_failing(self):
        self.stack.enter_context(patch.object(gateway_module, 'MAX_SESSION_FRAMES', 5))
        await self.start()
        for sequence in range(8):  # three frames past the cap
            self.phone.audio(sequence)
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertTrue(complete['durationLimited'])
        self.assertEqual(complete['durationMs'], 5 * 20)
        self.assertEqual(self.result()['status'], 'completed')      # saved, not failed
        self.assertTrue(self.result()['durationLimited'])
        self.assertEqual(self.saved_frames(), 5)                    # capped audio kept, extra dropped
        self.assertEqual(self.result()['durationMs'], 5 * 20)
        self.assertEqual(self.provider.finish_calls, 1)
        self.assertEqual(self.provider.open_calls, 1)
        self.assertFalse(any(event['type'] == 'error' for event in self.phone.sent))
        self.assertTrue(self.gateway.record('record-one')['durationLimited'])

    async def test_a_normal_stop_is_not_marked_duration_limited(self):
        await self.start()
        for sequence in range(3):
            self.phone.audio(sequence)
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.result()['status'], 'completed')
        self.assertFalse(complete['durationLimited'])
        self.assertFalse(complete['transcriptionDegraded'])
        self.assertNotIn('durationLimited', self.result())
        self.assertFalse(self.gateway.record('record-one')['durationLimited'])

    async def wait_for_phase(self, phase):
        while True:
            event = await self.phone.receive_type('status')
            if event['phase'] == phase:
                return event

    async def test_a_stalled_forward_degrades_and_the_recording_still_completes(self):
        self.stack.enter_context(patch.object(gateway_module, 'PROVIDER_APPEND_TIMEOUT', 0.05))
        await self.start(lambda provider: setattr(provider, 'block_append', True))
        for sequence in range(6):  # five frames fill one chunk; the append then stalls
            self.phone.audio(sequence)
        await self.wait_for_phase('transcription_degraded')
        await self.until(lambda: self.acked() == list(range(6)))  # saved frames are acked regardless
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertTrue(complete['transcriptionDegraded'])
        self.assertEqual(complete['durationMs'], 6 * 20)
        self.assertEqual(self.result()['status'], 'completed')      # saved, not failed
        self.assertTrue(self.result()['transcriptionDegraded'])
        self.assertEqual(self.saved_frames(), 6)                    # every captured frame kept
        self.assertEqual(self.provider.finish_calls, 0)             # a closed provider is not finished
        self.assertFalse(any(event['type'] == 'error' for event in self.phone.sent))
        self.assertTrue(self.gateway.record('record-one')['transcriptionDegraded'])

    async def test_a_stalled_connect_degrades_without_failing_the_recording(self):
        self.stack.enter_context(patch.object(gateway_module, 'PROVIDER_OPEN_TIMEOUT', 0.05))
        await self.start(lambda provider: setattr(provider, 'block_open', True))
        for sequence in range(4):
            self.phone.audio(sequence)
        await self.wait_for_phase('transcription_degraded')
        await self.until(lambda: self.acked() == list(range(4)))
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertTrue(complete['transcriptionDegraded'])
        self.assertEqual(self.result()['status'], 'completed')
        self.assertEqual(self.saved_frames(), 4)
        self.assertEqual(self.provider.open_calls, 1)
        self.assertEqual(self.provider.finish_calls, 0)
        self.assertFalse(any(event['type'] == 'error' for event in self.phone.sent))

    async def final_caption(self, item, text):
        caption = self.provider.transcript.apply({'type': 'conversation.item.input_audio_transcription.completed',
                                                  'item_id': item, 'transcript': text})
        await self.provider.emit(caption)
        return caption

    async def test_each_finished_sentence_is_translated_live_and_saved_with_its_source_revision(self):
        calls = []
        async def fake_text_task(http, task, segments, language='en'):
            calls.append((task, [row['source'] for row in segments], language))
            return {'translations': [{'id': segments[0]['id'], 'text': 'We review it on Wednesday.', 'language': language}]}
        self.stack.enter_context(patch.object(gateway_module, 'text_task', fake_text_task))
        await self.start()
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        await self.final_caption('seg-1', '我们周三复盘。')
        live = await self.phone.receive_type('translation')
        self.assertEqual(live['event'], {'type': 'translation', 'segmentId': 'seg-1', 'sourceRevision': 0, 'revision': 0,
                                         'language': 'en', 'text': 'We review it on Wednesday.', 'final': True})
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        row = complete['segments'][0]
        self.assertEqual((row['translation'], row['translationLanguage'], row['translationFinal']),
                         ('We review it on Wednesday.', 'en', True))
        self.assertEqual(self.result()['segments'][0]['translation'], 'We review it on Wednesday.')
        self.assertEqual(calls, [('translation', ['我们周三复盘。'], 'en')])

    async def test_a_translation_for_an_older_source_revision_is_never_attached(self):
        answers = iter(['Old meaning.'])
        async def fake_text_task(http, task, segments, language='en'):
            text = next(answers, None)
            if text is None:
                raise RuntimeError('Synthetic translation outage')
            return {'translations': [{'id': segments[0]['id'], 'text': text, 'language': language}]}
        self.stack.enter_context(patch.object(gateway_module, 'text_task', fake_text_task))
        await self.start()
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        await self.final_caption('seg-1', '初稿。')
        await self.phone.receive_type('translation')
        await self.final_caption('seg-1', '改过的终稿。')  # provider revises the same sentence
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        row = complete['segments'][0]
        self.assertEqual((row['source'], row['sourceRevision']), ('改过的终稿。', 1))
        self.assertEqual(row.get('translation', ''), '')
        self.assertEqual(self.result()['status'], 'completed')
        self.assertEqual(self.result()['translationFailures'], 1)

    async def test_partial_captions_are_not_translated_and_failures_never_fail_the_recording(self):
        async def failing_text_task(http, task, segments, language='en'):
            raise RuntimeError('Synthetic translation outage')
        self.stack.enter_context(patch.object(gateway_module, 'text_task', failing_text_task))
        await self.start(lambda provider: setattr(provider, 'partial_caption', True))
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        await self.final_caption('seg-2', '这句会尝试翻译。')
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.result()['status'], 'completed')
        self.assertEqual(self.result()['translationFailures'], 1)  # only the final sentence was attempted
        self.assertFalse(any(event['type'] in ('translation', 'error') for event in self.phone.sent))
        self.assertTrue(all(not row.get('translation') for row in complete['segments']))

    async def test_a_hard_provider_error_still_fails_loud_and_does_not_degrade(self):
        remote = MemoryProviderSocket()
        self.gateway.http = MemoryProviderHTTP(remote)
        await self.start(real_provider=True)
        self.phone.audio(0)
        await self.phone.receive_type('ack')
        await self.wait_for_phase('recording')   # connected to the provider
        remote.event({'type': 'error', 'error': {'code': 'synthetic_quota'}})
        error = await self.phone.receive_type('error', timeout=0.25)
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertIn('synthetic_quota', error['message'])
        self.assertEqual(self.result()['status'], 'failed')          # a rejection is not a stall
        self.assertNotIn('transcriptionDegraded', self.result())

    # --- An accepted stop finishes server-side ------------------------------------

    def fake_file_jobs(self):
        jobs = []
        async def create(ident, provider='stepfun', auto=False):
            jobs.append({'ident': ident, 'provider': provider, 'auto': auto,
                         'completeSent': any(event['type'] == 'complete' for event in self.phone.sent),
                         'status': self.result()['status']})
            return {'status': 'submitting'}
        self.stack.enter_context(patch.object(self.gateway, 'create_speaker_job', create))
        return jobs

    def slow_finish(self, seconds=0.1):
        provider = self.provider
        provider.finish_entered = asyncio.Event()
        async def finish():
            provider.finish_calls += 1
            provider.finish_entered.set()
            await asyncio.sleep(seconds)
            caption = provider.transcript.apply({'type': 'conversation.item.input_audio_transcription.completed',
                                                 'item_id': 'last', 'transcript': '最后一句。'})
            await provider.emit(caption)   # the phone is already gone; this must not fail the provider
            return provider.transcript.segments()
        provider.finish = finish

    async def test_phone_disconnect_after_stop_still_completes_and_starts_the_file_job(self):
        jobs = self.fake_file_jobs()
        await self.start(fileModel='stepfun')
        self.slow_finish()
        for sequence in range(10):
            self.phone.audio(sequence)
        await self.until(lambda: len(self.acked()) == 10)
        self.phone.text({'type': 'stop'})
        await asyncio.wait_for(self.provider.finish_entered.wait(), 0.5)
        self.phone.disconnect()                       # app backgrounded right after stop
        await asyncio.wait_for(self.stream_task, 1)
        self.assertEqual(self.result()['status'], 'completed')
        self.assertEqual(self.result()['segments'][0]['source'], '最后一句。')
        self.assertEqual(self.saved_frames(), 10)
        self.assertEqual([(j['provider'], j['auto'], j['status']) for j in jobs], [('stepfun', True, 'completed')])
        self.assertNotIn('fileJobPending', self.result())
        self.assertFalse(self.gateway.active)

    async def test_handler_cancellation_after_stop_still_completes(self):
        await self.start()
        self.slow_finish()
        self.phone.audio(0)
        await self.until(lambda: self.acked() == [0])
        self.phone.text({'type': 'stop'})
        await asyncio.wait_for(self.provider.finish_entered.wait(), 0.5)
        self.stream_task.cancel()                     # aiohttp's handler_cancellation on a lost connection
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(self.stream_task, 1)
        self.assertEqual(self.result()['status'], 'completed')
        self.assertFalse(self.gateway.active)

    async def test_accepted_stop_waits_a_bounded_time_then_keeps_the_audio_as_interrupted(self):
        self.stack.enter_context(patch.object(gateway_module, 'STOP_FINISH_SECONDS', 0.1))
        await self.start()
        self.slow_finish(seconds=30)
        self.phone.audio(0)
        await self.until(lambda: self.acked() == [0])
        self.phone.text({'type': 'stop'})
        await asyncio.wait_for(self.provider.finish_entered.wait(), 0.5)
        self.phone.disconnect()
        await asyncio.wait_for(self.stream_task, 1)
        self.assertEqual(self.result()['status'], 'interrupted')
        self.assertTrue(self.result()['finishTimedOut'])
        self.assertEqual(self.saved_frames(), 1)

    async def test_file_job_and_document_are_created_before_complete_is_sent(self):
        jobs = self.fake_file_jobs()
        await self.start(fileModel='stepfun')
        self.phone.audio(0)
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual([j['completeSent'] for j in jobs], [False])
        queued = []
        class Documents:
            async def enqueue(inner, record, retry=False):
                queued.append(any(event['type'] == 'complete' for event in self.phone.sent))
            def public(inner, ident, record=None):
                return {'status': 'idle'}
        self.phone = type(self.phone)()
        self.stack.enter_context(patch.object(gateway_module.web, 'WebSocketResponse', return_value=self.phone))
        self.gateway.documents = Documents()
        self.stream_task = asyncio.create_task(self.gateway.stream(SimpleNamespace(headers={'Origin': self.gateway.origin})))
        self.phone.text({'type': 'start', 'recordingId': 'record-two', 'title': '文档', 'sourceType': 'live_device', 'language': 'zh'})
        await self.phone.receive_type('ready')
        self.phone.audio(0)
        await self.until(lambda: self.provider.open_calls == 1)
        await self.final_caption('only', '有文字。')
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(queued, [False])

    async def test_failed_live_session_with_a_file_model_still_gets_its_file_job(self):
        jobs = []
        async def create(ident, provider='stepfun', auto=False):
            jobs.append((ident, provider, auto, self.result()['status']))
            return {'status': 'submitting'}
        self.stack.enter_context(patch.object(self.gateway, 'create_speaker_job', create))
        await self.start(lambda provider: setattr(provider, 'append_error', True), fileModel='stepfun')
        for sequence in range(6):
            self.phone.audio(sequence)
        await self.phone.receive_type('error')          # a hard provider failure
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.result()['status'], 'failed')
        self.assertEqual(jobs, [('record-one', 'stepfun', True, 'failed')])
        self.assertNotIn('fileJobPending', self.result())

    async def test_service_stop_defers_the_file_job_to_the_next_start(self):
        jobs = self.fake_file_jobs()
        await self.start(fileModel='stepfun')
        self.phone.audio(0)
        await self.until(lambda: self.acked() == [0])
        self.gateway.shutting_down = True
        self.phone.disconnect()
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.result()['status'], 'interrupted')
        self.assertTrue(self.result()['fileJobPending'])   # durable intent; startup creates the job
        self.assertEqual(jobs, [])

    async def test_a_stepfun_recording_without_detected_speech_completes_with_no_text(self):
        remote = MemoryProviderSocket()
        self.gateway.http = MemoryProviderHTTP(remote)
        jobs = self.fake_file_jobs()
        for name, value in (('PADDING_CHUNKS', 2), ('PADDING_INTERVAL', 0.01), ('QUIET_SECONDS', 0.05)):
            self.stack.enter_context(patch.object(StepStream, name, value))
        await self.start(real_provider=True, fileModel='stepfun')
        for sequence in range(5):   # silence: the provider reports nothing
            self.phone.audio(sequence)
        await self.wait_for_phase('recording')
        self.phone.text({'type': 'stop'})
        complete = await self.phone.receive_type('complete', timeout=2)
        await asyncio.wait_for(self.stream_task, 1)
        self.assertEqual(complete['segments'], [])
        self.assertEqual(self.result()['status'], 'completed')
        self.assertEqual([(j['provider'], j['auto']) for j in jobs], [('stepfun', True)])

    # --- Acks follow saving; provider trouble degrades ------------------------------

    async def test_frames_are_acknowledged_once_saved_before_the_provider_connects(self):
        await self.start(lambda provider: setattr(provider, 'block_open', True))
        for sequence in range(50):
            self.phone.audio(sequence)
        await self.until(lambda: len(self.acked()) == 50)
        self.assertEqual(self.provider.open_calls, 1)
        self.assertFalse(self.provider.appended)

    def test_provider_waits_fit_inside_the_forward_backlog(self):
        backlog_seconds = gateway_module.FORWARD_QUEUE_FRAMES * 0.02
        self.assertLess(gateway_module.PROVIDER_OPEN_TIMEOUT, backlog_seconds)
        self.assertLess(gateway_module.PROVIDER_APPEND_TIMEOUT, backlog_seconds)

    async def test_provider_connection_errors_degrade_instead_of_failing(self):
        connector = aiohttp.ClientConnectorError(SimpleNamespace(host='provider.invalid', port=443, ssl=True),
                                                 OSError(61, 'Connection refused'))
        for label, failure in (('connect', connector), ('reset', ConnectionResetError('upstream reset'))):
            with self.subTest(label):
                self.phone = MemoryPhone()
                self.stack.enter_context(patch.object(gateway_module.web, 'WebSocketResponse', return_value=self.phone))
                def configure(provider, failure=failure, label=label):
                    async def broken(*args):
                        provider.open_calls += 1
                        if label == 'reset':
                            provider.ws = True
                        raise failure
                    if label == 'connect':
                        provider.open = broken
                    else:
                        provider.append = broken
                ident = 'record-' + label
                def create(http, language, emit):
                    self.provider = ControlledStream(http, language, emit)
                    configure(self.provider)
                    return self.provider
                with patch.object(gateway_module, 'StepStream', create):
                    task = asyncio.create_task(self.gateway.stream(SimpleNamespace(headers={'Origin': self.gateway.origin})))
                    self.phone.text({'type': 'start', 'recordingId': ident, 'title': 't', 'sourceType': 'live_device', 'language': 'zh'})
                    await self.phone.receive_type('ready')
                    for sequence in range(6):
                        self.phone.audio(sequence)
                    await self.wait_for_phase('transcription_degraded')
                    self.phone.text({'type': 'stop'})
                    complete = await self.phone.receive_type('complete')
                    await asyncio.wait_for(task, 0.5)
                result = json.loads((self.path / 'records' / ident / 'result.json').read_text())
                self.assertTrue(complete['transcriptionDegraded'])
                self.assertEqual(result['status'], 'completed')
                self.assertFalse(any(event['type'] == 'error' for event in self.phone.sent))

    # --- File-recognition limit is announced, not silent ----------------------------

    async def test_file_recognition_limit_is_announced_at_ready_and_when_reached(self):
        limit = 44 + 640 * 3   # two frames still fit; the third reaches the upload limit
        self.stack.enter_context(patch.object(gateway_module.file_asr, 'MAX_AUDIO_BYTES', limit))
        ready = await self.start(liveModel='none', fileModel='stepfun')
        self.assertEqual(ready['fileAsrMaxMs'], 40)
        for sequence in range(5):
            self.phone.audio(sequence)
        await self.until(lambda: len(self.acked()) == 5)
        status = lambda: [event for event in self.phone.sent if event['type'] == 'status']
        await self.until(lambda: any(event['phase'] == 'recording' for event in status()))
        self.assertIn('上限', [e for e in status() if e['phase'] == 'recording'][0]['message'])
        warnings = [event for event in status() if event['phase'] == 'file_limit_reached']
        self.assertEqual(len(warnings), 1)                 # once, while recording continues
        self.assertIn('不会自动生成全文', warnings[0]['message'])
        self.phone.text({'type': 'stop'})
        await self.phone.receive_type('complete')
        await asyncio.wait_for(self.stream_task, 0.5)
        self.assertEqual(self.result()['fileLimitReachedAtMs'], 60)
        record = self.gateway.record('record-one')
        self.assertIn('99 MB', record['fileJobError'])     # the reason is on the record, not lost
        self.assertEqual(record['speakerJob']['status'], 'failed')
        self.assertFalse(record['speakerJob']['submitted'])
        self.assertIsNone(self.gateway.speaker_job('record-one'))

class SourceIdentityValidationTests(unittest.TestCase):
    def test_exact_contract_accepts_uint32_and_js_safe_integer_boundaries(self):
        for first, file_id, received in ((0, 1, 1), (0xffffffff, 0xffffffff, 2**53 - 1)):
            command = identity_message(first)
            command['identity'].update(fileId=file_id, firstReceivedAtMs=received)
            self.assertEqual(source_identity(command, 'record-one'), command['identity'])

    def test_rejects_ambiguous_types_missing_extra_fields_and_wrong_recording(self):
        invalid_values = {
            'schemaVersion': (True, 0, 2, '1'), 'protocol': ('other', None),
            'fileId': (False, 0, -1, 2**32, 1.5, '123'),
            'jsapiDeviceId': ('', '   ', 'x' * 257, None, 42),
            'sourceType': ('live_device', 'recorded_file_test'),
            'firstSequence': (True, -1, 2**32, 0.1, '7'),
            'firstReceivedAtMs': (True, 0, -1, 2**53, 1.1, '1'),
            'headerIdMatched': (False, 1, 'true', None)
        }
        for field, values in invalid_values.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    command = identity_message()
                    command['identity'][field] = value
                    with self.assertRaisesRegex(ValueError, '^Invalid source identity declaration$'):
                        source_identity(command, 'record-one')
        for mutation in ('missing', 'extra_identity', 'extra_command', 'wrong_recording', 'not_object'):
            with self.subTest(mutation=mutation):
                command = identity_message()
                if mutation == 'missing': del command['identity']['fileId']
                elif mutation == 'extra_identity': command['identity']['nativeAssociation'] = True
                elif mutation == 'extra_command': command['nativeAssociation'] = True
                elif mutation == 'wrong_recording': command['recordingId'] = 'other'
                else: command['identity'] = []
                with self.assertRaisesRegex(ValueError, '^Invalid source identity declaration$'):
                    source_identity(command, 'record-one')


class ProviderReliabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_eof_during_handshake_wakes_the_open_waiter(self):
        remote = MemoryProviderSocket(handshake=False)
        remote.disconnect()
        stream = StepStream(MemoryProviderHTTP(remote), 'zh', self.emit)
        try:
            with patch('stepfun.credential', return_value='synthetic-no-real-key'):
                with self.assertRaisesRegex(RuntimeError, 'closed'):
                    await asyncio.wait_for(stream.open(), 0.25)
        finally:
            await stream.close()

    async def test_total_finish_deadline_bounds_a_stalled_padding_send(self):
        stream = StepStream(None, 'zh', self.emit)
        stream.receiver = asyncio.create_task(asyncio.Event().wait())
        async def stalled_send(event):
            await asyncio.Event().wait()
        try:
            with patch.object(stream, 'send', stalled_send), \
                    patch.object(StepStream, 'FINISH_TIMEOUT_SECONDS', 0.05, create=True):
                with self.assertRaisesRegex(RuntimeError, 'timed out'):
                    await asyncio.wait_for(stream.finish(), 0.25)
        finally:
            await stream.close()

    async def test_finish_waits_for_a_detected_sentence_but_not_for_silence(self):
        stream = StepStream(None, 'zh', self.emit)
        stream.receiver = asyncio.create_task(asyncio.Event().wait())
        async def sent(event):
            pass
        try:
            with patch.object(stream, 'send', sent), patch.object(StepStream, 'PADDING_CHUNKS', 1), \
                    patch.object(StepStream, 'PADDING_INTERVAL', 0), patch.object(StepStream, 'QUIET_SECONDS', 0.02):
                stream.last_event = 0
                self.assertEqual(await asyncio.wait_for(stream.finish(), 1), [])   # no speech: empty, complete
                stream.transcript.apply({'type': 'input_audio_buffer.speech_started', 'item_id': 'one', 'audio_start_ms': 0})
                waiting = asyncio.create_task(stream.finish())
                await asyncio.sleep(0.1)
                self.assertFalse(waiting.done())                                   # a detected sentence is awaited
                stream.transcript.apply({'type': 'conversation.item.input_audio_transcription.completed',
                                         'item_id': 'one', 'transcript': '说完了。'})
                rows = await asyncio.wait_for(waiting, 1)
                self.assertEqual([row['source'] for row in rows], ['说完了。'])
        finally:
            await stream.close()

    async def emit(self, event):
        pass


if __name__ == '__main__':
    unittest.main()
