"""Doubao (Volcengine) ASR: streaming 2.0 over the v3 binary WebSocket and file
recognition 2.0 by URL. The access token stays on the server; no request or
response body is logged, and errors expose only bounded provider codes."""
import asyncio
import gzip
import json
import math
import os
import re
import struct
import time
import uuid
import zlib
from pathlib import Path

import aiohttp

STREAM_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
STREAM_RESOURCE = 'volc.seedasr.sauc.duration'
FILE_BASE = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/'
FILE_RESOURCE = 'volc.seedasr.auc'
FULL_REQUEST, AUDIO_REQUEST, FULL_RESPONSE, ERROR_RESPONSE = 0b0001, 0b0010, 0b1001, 0b1111
JSON, RAW, GZIP = 0b0001, 0b0000, 0b0001
DONE, RUNNING, QUEUED = '20000000', '20000001', '20000002'
# A 'full' result repeats every utterance so far, so both bounds below grow with
# the session: 20000 utterances covers the 4-hour session at a new one every
# 0.72 s, and one decompressed response may hold all of them with word timings.
MAX_UTTERANCES = 20000
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
HAN = re.compile('[\u3400-\u9fff]')
LATIN = re.compile('[A-Za-z]')


def text_language(text, fallback='zh'):
    """Per sentence: any Han character makes it Chinese, Latin letters alone English."""
    if isinstance(text, str) and HAN.search(text):
        return 'zh'
    if isinstance(text, str) and LATIN.search(text):
        return 'en'
    return fallback if fallback in ('zh', 'en') else 'zh'


def credentials():
    app = os.environ.get('VOLC_ASR_APP_ID', '').strip()
    token = os.environ.get('VOLC_ASR_TOKEN', '').strip()
    token_file = os.environ.get('VOLC_ASR_TOKEN_FILE', '').strip()
    if not token and token_file:
        path = Path(token_file)
        if path.stat().st_mode & 0o077:
            raise RuntimeError('Doubao token file must be mode 0600')
        token = path.read_text().strip()
    if not app or not token:
        raise RuntimeError('Doubao ASR is not configured')
    return app, token


def configured():
    try:
        credentials()
        return True
    except (OSError, RuntimeError):
        return False


def headers(resource, request_id):
    app, token = credentials()
    return {'X-Api-App-Key': app, 'X-Api-Access-Key': token, 'X-Api-Resource-Id': resource,
            'X-Api-Request-Id': request_id}


def frame(message_type, flags, serialization, payload, sequence):
    body = gzip.compress(payload)
    return (bytes([0x11, (message_type << 4) | flags, (serialization << 4) | GZIP, 0]) +
            struct.pack('>i', sequence) + struct.pack('>I', len(body)) + body)


def bounded_gunzip(data, limit):
    """gzip.decompress that refuses to expand past `limit` bytes."""
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    value = inflater.decompress(data, limit + 1)
    if len(value) > limit or inflater.unconsumed_tail:
        raise ValueError('Doubao response is larger than allowed')
    return value


def parse_frame(message):
    """Return (kind, sequence, last, value); kind is 'result' or 'error'."""
    if not isinstance(message, (bytes, bytearray)) or len(message) < 4:
        raise ValueError('Invalid Doubao frame')
    size, kind, flags = (message[0] & 0x0F) * 4, message[1] >> 4, message[1] & 0x0F
    serialization, compression = message[2] >> 4, message[2] & 0x0F
    payload, sequence = bytes(message[size:]), None
    if flags & 0x01:
        sequence, payload = struct.unpack('>i', payload[:4])[0], payload[4:]
    if flags & 0x04:
        payload = payload[4:]
    if kind == ERROR_RESPONSE:
        code, length = struct.unpack('>I', payload[:4])[0], struct.unpack('>I', payload[4:8])[0]
        return 'error', sequence, True, code
    if kind != FULL_RESPONSE:
        raise ValueError('Unexpected Doubao frame type')
    length = struct.unpack('>I', payload[:4])[0]
    payload = payload[4:4 + length]
    if compression == GZIP and payload:
        payload = bounded_gunzip(payload, MAX_RESPONSE_BYTES)
    value = json.loads(payload.decode('utf-8')) if serialization == JSON and payload else {}
    return 'result', sequence, bool(flags & 0x02), value


class VolcTranscript:
    """Rows follow the StepFun transcript shape; utterance order is the identity,
    and a definite utterance is final. Timing comes only from the provider."""

    def __init__(self, language='zh'):
        self.language = language
        self.rows = []
        self.settled = 0  # leading rows already final; a later package never changes them
        self.audio_ms = 0
        self.delta_events = 0
        self.final_events = 0
        self.timing_events = []

    def apply(self, value):
        utterances = (value.get('result') or {}).get('utterances') if isinstance(value, dict) else None
        if not isinstance(utterances, list):
            return []
        captions = []
        for index in range(self.settled, min(len(utterances), MAX_UTTERANCES)):
            utterance = utterances[index]
            if not isinstance(utterance, dict):
                continue
            text = utterance.get('text')
            if not isinstance(text, str) or len(text) > 2000:
                raise ValueError('Invalid provider transcription')
            final = utterance.get('definite') is True
            while len(self.rows) <= index:
                self.rows.append({'id': 'volc-' + str(len(self.rows)), 'source': '', 'sourceLanguage': self.language,
                                  'sourceRevision': -1, 'sourceFinal': False, 'translation': '',
                                  'translationLanguage': 'en' if self.language == 'zh' else 'zh',
                                  'translationRevision': -1, 'translationFinal': False,
                                  'startMs': None, 'endMs': None, 'speaker': '发言人'})
            row = self.rows[index]
            start, end = utterance.get('start_time'), utterance.get('end_time')
            if start is None:
                # Doubao never sends start_time for the first utterance of a stream
                # (seen on every live recording); it starts where the one before
                # it ended, which for the first is the start of the audio.
                start = self.rows[index - 1]['endMs'] if index else 0
            timed = all(isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t) and t >= 0
                        for t in (start, end)) and end >= start
            if row['sourceFinal'] or (row['source'] == text and not final) or not text:
                continue
            if timed:
                row['startMs'], row['endMs'] = round(start), round(end)
            spoken = text_language(text, self.language)
            row.update(source=text, sourceRevision=row['sourceRevision'] + 1, sourceFinal=final, sourceLanguage=spoken,
                       translationLanguage='en' if spoken == 'zh' else 'zh')
            if final:
                self.final_events += 1
            else:
                self.delta_events += 1
            captions.append({'type': 'transcript', 'segmentId': row['id'], 'revision': row['sourceRevision'],
                             'language': spoken, 'text': text, 'final': final,
                             'startMs': row['startMs'], 'endMs': row['endMs'], 'speaker': row['speaker']})
        while self.settled < len(self.rows) and self.rows[self.settled]['sourceFinal']:
            self.settled += 1
        return captions

    def finalize(self):
        # The last package settles the transcript; an utterance still marked
        # non-definite at that point is the provider's final wording for it.
        for row in self.rows:
            if row['source'] and not row['sourceFinal']:
                row['sourceFinal'] = True

    def segments(self):
        return [dict(row) for row in self.rows if row['source']]


class VolcStream:
    """Same interface as StepStream: open, append, finish, close, check."""
    FINISH_TIMEOUT_SECONDS = 30
    payload = {'user': {'uid': 'luyindou'},
               'audio': {'format': 'pcm', 'codec': 'raw', 'rate': 16000, 'bits': 16, 'channel': 1},
               'request': {'model_name': 'bigmodel', 'enable_itn': True, 'enable_punc': True,
                           'show_utterances': True, 'result_type': 'full', 'enable_nonstream': True}}

    def __init__(self, http, language, emit):
        self.http, self.language, self.emit = http, language, emit
        self.transcript = VolcTranscript(language)
        self.ready, self.stopped, self.completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        self.ws = self.receiver = None
        self.failure = None
        self.closing = False
        self.sequence = 1
        self.last_event = time.monotonic()
        self.audio_bytes = 0

    async def open(self):
        self.ws = await self.http.ws_connect(STREAM_URL, headers=headers(STREAM_RESOURCE, str(uuid.uuid4())),
                                             timeout=15, heartbeat=20, max_msg_size=2**22)
        self.receiver = asyncio.create_task(self.receive())
        await self.ws.send_bytes(frame(FULL_REQUEST, 0b0001, JSON, json.dumps(self.payload).encode(), self.sequence))
        await asyncio.wait_for(self.ready.wait(), 12)
        self.check()

    def check(self):
        if self.failure:
            raise RuntimeError(self.failure)
        if self.receiver and self.receiver.done():
            raise RuntimeError('ASR connection closed before completion')

    async def receive(self):
        try:
            async for msg in self.ws:
                if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
                if msg.type != aiohttp.WSMsgType.BINARY:
                    continue
                kind, _, last, value = parse_frame(msg.data)
                self.last_event = time.monotonic()
                if kind == 'error':
                    self.failure = 'Doubao rejected the request (' + str(value)[:12] + ')'
                    break
                self.ready.set()
                for caption in self.transcript.apply(value):
                    await self.emit(caption)
                if last:
                    self.transcript.finalize()
                    self.completed.set()
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            self.failure = 'ASR response processing failed'
        finally:
            if not self.closing and self.failure is None and not self.completed.is_set():
                self.failure = 'ASR connection closed before completion'
            self.ready.set()
            self.completed.set()
            self.stopped.set()

    async def append(self, pcm, padding=False):
        self.check()
        self.sequence += 1
        await asyncio.wait_for(self.ws.send_bytes(frame(AUDIO_REQUEST, 0b0001, RAW, pcm, self.sequence)), 10)
        if not padding:
            self.audio_bytes += len(pcm)
            self.transcript.audio_ms = self.audio_bytes / 32

    async def finish(self):
        try:
            return await asyncio.wait_for(self._finish(), self.FINISH_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            raise RuntimeError('ASR finish timed out; audio has been retained') from error

    async def _finish(self):
        self.check()
        self.sequence += 1
        # A negative sequence marks the last packet; the final package follows.
        await asyncio.wait_for(self.ws.send_bytes(frame(AUDIO_REQUEST, 0b0011, RAW, b'', -self.sequence)), 10)
        await self.completed.wait()
        if self.failure:
            raise RuntimeError(self.failure)
        return self.transcript.segments()

    async def close(self):
        self.closing = True
        if self.receiver:
            self.receiver.cancel()
            await asyncio.gather(self.receiver, return_exceptions=True)
        if self.ws:
            await self.ws.close()


async def file_submit(http, audio_url, request_id):
    body = {'user': {'uid': 'luyindou'},
            'audio': {'url': audio_url, 'format': 'wav', 'codec': 'raw', 'rate': 16000, 'bits': 16, 'channel': 1},
            'request': {'model_name': 'bigmodel', 'enable_itn': True, 'enable_punc': True,
                        'show_utterances': True, 'enable_speaker_info': True}}
    request_headers = dict(headers(FILE_RESOURCE, request_id), **{'X-Api-Sequence': '-1'})
    async with http.post(FILE_BASE + 'submit', json=body, headers=request_headers,
                         timeout=aiohttp.ClientTimeout(total=40)) as response:
        code = response.headers.get('X-Api-Status-Code', '')
        if response.status != 200 or code != DONE:
            raise RuntimeError('豆包文件识别提交未确认（' + (code or 'HTTP ' + str(response.status))[:12] + '），未自动重试')
    return request_id


async def file_query(http, task):
    """Normalized to the StepFun status vocabulary the job runner uses."""
    async with http.post(FILE_BASE + 'query', data='{}', headers=dict(headers(FILE_RESOURCE, task),
                         **{'Content-Type': 'application/json'}), timeout=aiohttp.ClientTimeout(total=40)) as response:
        code = response.headers.get('X-Api-Status-Code', '')
        if response.status != 200:
            raise RuntimeError('豆包文件识别进度暂不可用（HTTP ' + str(response.status) + '）')
        if code in (RUNNING, QUEUED):
            return {'status': 'RUNNING' if code == RUNNING else 'PENDING'}
        if code != DONE:
            return {'status': 'FAILED', 'code': code[:12]}
        value = await response.json()
    value['status'] = 'SUCCEEDED'
    return value


def file_parse(value, duration_ms, job_id, language='zh'):
    """Provider utterances only. Speaker labels come from the provider; when it
    gives none, every row stays a single unnamed speaker."""
    utterances = (value.get('result') or {}).get('utterances') if isinstance(value, dict) else None
    if not isinstance(utterances, list) or not utterances:
        raise ValueError('豆包文件识别没有返回分句结果')
    rows, names = [], {}
    for utterance in utterances:
        if not isinstance(utterance, dict):
            raise ValueError('豆包文件识别分句格式无效')
        text, start, end = utterance.get('text'), utterance.get('start_time'), utterance.get('end_time')
        if not isinstance(text, str) or len(text) > 2000:
            raise ValueError('豆包文件识别分句格式无效')
        if not text.strip():
            continue
        if any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t)
               for t in (start, end)) or start < 0 or end <= start:
            raise ValueError('豆包文件识别时间戳无效')
        if start >= duration_ms or end > duration_ms + 2000:
            raise ValueError('豆包文件识别时间与已保存音频不一致')
        additions = utterance.get('additions') if isinstance(utterance.get('additions'), dict) else {}
        speaker = additions.get('speaker', additions.get('speaker_id'))
        key = str(speaker)[:100] if isinstance(speaker, (str, int)) and str(speaker) != '' else ''
        names.setdefault(key, '发言人 ' + str(len(names) + 1) if key else '发言人')
        rows.append({'id': 'file-' + job_id + '-' + str(len(rows)), 'source': text, 'sourceLanguage': text_language(text, language),
                     'sourceRevision': 0, 'sourceFinal': True, 'startMs': round(start),
                     'endMs': min(duration_ms, round(end)), 'speaker': names[key], 'providerSpeakerId': key or None})
    if not rows or len(rows) > 20000 or len(names) > 10:
        raise ValueError('豆包文件识别分句或发言人数量无效')
    rows.sort(key=lambda row: (row['startMs'], row['endMs']))
    return rows
