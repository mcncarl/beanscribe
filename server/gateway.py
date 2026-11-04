"""Private H5 gateway: authenticated pages, JSAPI signing, Opus -> StepFun.

Default bind is loopback. No tunnel, publication, BLE or recording starts here.
Long-lived credentials stay server-side. Saved audio is never automatically deleted.
"""
import argparse
import asyncio
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import struct
import time
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web

from opus import OpusDecoder, QuietRanges
from stepfun import StepStream, text_task
import volc
from volc import VolcStream
import file_asr
import feishu_docs
from feishu_login import FeishuLogin

ROOT = Path(__file__).resolve().parent.parent
ID = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$')
APP_ID = os.environ.get('FEISHU_APP_ID', '').strip()
MAX_SESSION_FRAMES = 4 * 3600 * 50  # 20 ms frames in four hours; the provider's realtime cap
# Frames are acknowledged once saved, so provider work never holds up the phone.
# Forwarding work queued for the provider is bounded; past it the live transcript
# is abandoned (degraded) and capture continues. Both provider waits below stay
# well under the time this backlog covers (1024 frames = 20.48 s).
FORWARD_QUEUE_FRAMES = 1024
PROVIDER_OPEN_TIMEOUT = 15  # a provider connect slower than this degrades instead of failing
PROVIDER_APPEND_TIMEOUT = 10  # a stalled forward degrades
# Connection-level provider failures degrade like stalls; provider rejections
# (error events, handshake refusals, protocol errors) still fail loud.
DEGRADABLE_PROVIDER_ERRORS = (asyncio.TimeoutError, aiohttp.ClientConnectionError, ConnectionError)
STOP_FINISH_SECONDS = 120  # after an accepted stop, finalization outlives the phone for this long
PROVIDER_CLOSE_SECONDS = 5
WS_CLOSE_TIMEOUT = 2  # how long a server-side close waits for the phone's close reply
# Service stop must fit the unit's TimeoutStopSec=15 with margin: streams get
# SHUTDOWN_STREAM_SECONDS to persist (an accepted stop gets SHUTDOWN_FINISH_SECONDS
# more to finish, then a SHUTDOWN_PROVIDER_CLOSE_SECONDS provider close); in-flight
# submissions and document creates get SHUTDOWN_TASK_SECONDS; aiohttp's own
# handler wait is SHUTDOWN_TIMEOUT (it waits at most twice that).
SHUTDOWN_STREAM_SECONDS = 8
SHUTDOWN_FINISH_SECONDS = 3
SHUTDOWN_PROVIDER_CLOSE_SECONDS = 2
SHUTDOWN_TASK_SECONDS = 2
SHUTDOWN_TIMEOUT = 1
WAV_HEADER_BYTES = 44
FRAME_BYTES = 640  # 20 ms of 16 kHz mono 16-bit PCM
LOGIN_FAILURES, LOGIN_WINDOW_SECONDS, LOGIN_CLIENTS = 10, 60, 4096
DIAGNOSTIC_MAX_BYTES = 2 * 1024 * 1024  # runtime.jsonl rotates once to runtime.jsonl.1
LIVE_TRANSLATION_TIMEOUT = 20  # one sentence; a slower answer is dropped, the caption stays
LIVE_TRANSLATION_CONCURRENCY = 2
LIVE_TRANSLATION_FINISH_SECONDS = 8  # how long stop waits for translations still in flight
# 'none' records audio only; the full text comes from file recognition afterwards.
LIVE_MODELS = ('stepfun', 'doubao', 'none')
FILE_MODELS = ('stepfun', 'doubao')
PROVIDER_LABELS = {'stepfun': 'StepFun', 'doubao': '豆包'}
TRANSLATION_BATCH = 40  # rows per translation request for an applied file transcript
SDK_URL = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.16.js'
LOGIN = '''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>录音豆 · 私有测试</title><style>body{font:17px system-ui;max-width:400px;margin:15vh auto;padding:24px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin:8px 0}p{color:#606570}</style>
<h1>录音豆</h1><p>输入本次私有测试口令。页面与录音仅在通过验证后可访问。</p>
<form><input type="password" autocomplete="off" aria-label="测试口令" required><button>进入</button></form><p id="message"></p>
<script>const base=__MINUTES_BASE__,destination=__MINUTES_DESTINATION__;document.querySelector('form').onsubmit=async e=>{e.preventDefault();let r=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.querySelector('input').value})});if(r.ok)location.replace(destination);else document.querySelector('#message').textContent='口令不正确或请求暂时受限';};</script>'''


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
    temporary.replace(path)


def canonical_data_size(head):
    """The data size a canonical 44-byte 16 kHz mono 16-bit PCM header declares, else None."""
    if (len(head) < WAV_HEADER_BYTES or head[0:4] != b'RIFF' or head[8:12] != b'WAVE' or
            head[12:16] != b'fmt ' or head[36:40] != b'data' or struct.unpack_from('<I', head, 16)[0] != 16):
        return None
    audio_format, channels = struct.unpack_from('<HH', head, 20)
    rate = struct.unpack_from('<I', head, 24)[0]
    block_align, bits = struct.unpack_from('<HH', head, 32)
    if (audio_format, channels, rate, block_align, bits) != (1, 1, 16000, 2, 16):
        return None
    return struct.unpack_from('<I', head, 40)[0]


def clean_wav_bytes(path):
    """PCM bytes of a cleanly closed recording: the header matches the audio on disk.

    A stale header (process death before close) or any other layout returns None."""
    try:
        size = path.stat().st_size
        with path.open('rb') as stream:
            declared = canonical_data_size(stream.read(WAV_HEADER_BYTES))
    except OSError:
        return None
    if declared is None or declared != size - WAV_HEADER_BYTES:
        return None
    return declared


def recover_wav_header(path):
    """Repair a PCM WAV whose header was left stale by an unclean exit.

    A clean stop closes the file and patches the RIFF/data sizes. Process death
    (force kill, power loss) never runs that patch, so the header keeps the
    first frame's length and a fully captured recording reads as a 20 ms
    fragment even though every sample is on disk. Grow the header back to the
    audio physically present; never shrink it or invent samples. Returns the
    recovered duration in milliseconds only when the header was actually
    truncated, otherwise None (a clean, empty, or non-matching file)."""
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size < WAV_HEADER_BYTES:
        return None
    with path.open('r+b') as stream:
        head = bytearray(stream.read(WAV_HEADER_BYTES))
        header_data = canonical_data_size(head)
        if header_data is None:
            return None
        actual_data = (size - WAV_HEADER_BYTES) // 2 * 2
        if actual_data <= header_data:
            # Nothing to grow into: a clean close already matches, the file is
            # empty, or the header claims more than exists (not our truncation).
            return None
        struct.pack_into('<I', head, 4, 36 + actual_data)
        struct.pack_into('<I', head, 40, actual_data)
        stream.seek(0)
        stream.write(head)
        stream.flush()
        os.fsync(stream.fileno())
    return round(actual_data // 2 / 16000 * 1000)


def normalized_base_path(value):
    value = value.rstrip('/')
    if not re.fullmatch(r'(?:/[A-Za-z0-9][A-Za-z0-9_-]*)*', value):
        raise ValueError('Base path must contain only ordinary URL path segments')
    return value


def signing_url(value, origin, base_path=''):
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError('Invalid signing URL')
    part = urlsplit(value)
    if part.username or part.password or part.fragment or part.scheme + '://' + part.netloc != origin:
        raise ValueError('Signing URL must match the configured private origin')
    if part.path not in (base_path + '/preview.html', base_path + '/h5/index.html'):
        raise ValueError('This page is not allowed to request JSAPI signing')
    return value


def iso_time(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace('+00:00', 'Z')


def metadata(value):
    if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not ID.fullmatch(value['id']):
        raise ValueError('Invalid recording metadata')
    allowed = ('schemaVersion', 'id', 'title', 'sourceLabel', 'createdAt', 'updatedAt', 'startedAt', 'endedAt',
               'state', 'durationMs', 'segments', 'audioMimeType', 'summary', 'chapters', 'summaryStatus',
               'summaryError', 'translationStatus', 'translationError', 'silenceRanges', 'sourceType',
               'language', 'summaryStale', 'speakerDiarization', 'contentEdited', 'sourceVersion')
    result = {key: value[key] for key in allowed if key in value}
    for key in ('title', 'sourceLabel'):
        if key in result and (not isinstance(result[key], str) or len(result[key]) > 500):
            raise ValueError('Invalid recording title or source')
    if 'segments' in result:
        rows = result['segments']
        if not isinstance(rows, list) or len(rows) > 20000:
            raise ValueError('Invalid recording segments')
        seen = set()
        for row in rows:
            if (not isinstance(row, dict) or not isinstance(row.get('id'), str) or
                    not row['id'] or row['id'] in seen or len(row['id']) > 80 or
                    not isinstance(row.get('source'), str) or len(row['source']) > 2000):
                raise ValueError('Invalid or duplicate saved segment')
            seen.add(row['id'])
            for key in ('startMs', 'endMs'):
                timing = row.get(key)
                if timing is not None and (isinstance(timing, bool) or not isinstance(timing, (int, float)) or
                                           not math.isfinite(timing) or timing < 0):
                    raise ValueError('Invalid saved segment timestamp')
            if 'speaker' in row and (not isinstance(row['speaker'], str) or len(row['speaker']) > 200):
                raise ValueError('Invalid speaker name')
    result['updatedAt'] = iso_time(time.time())
    return result


def source_identity(command, recording_id):
    """Validate a client declaration, not a server-authenticated hardware identity."""
    fields = {'schemaVersion', 'protocol', 'fileId', 'jsapiDeviceId', 'sourceType',
              'firstSequence', 'firstReceivedAtMs', 'headerIdMatched'}
    if (not isinstance(command, dict) or set(command) != {'type', 'recordingId', 'identity'} or
            command.get('type') != 'source_identity' or command.get('recordingId') != recording_id):
        raise ValueError('Invalid source identity declaration')
    value = command.get('identity')
    if (not isinstance(value, dict) or set(value) != fields or
            type(value.get('schemaVersion')) is not int or value['schemaVersion'] != 1 or
            value.get('protocol') != 'soundcore-d3200' or
            type(value.get('fileId')) is not int or not 1 <= value['fileId'] <= 0xffffffff or
            not isinstance(value.get('jsapiDeviceId'), str) or
            not value['jsapiDeviceId'].strip() or len(value['jsapiDeviceId']) > 256 or
            value.get('sourceType') != 'live_device_recording' or
            type(value.get('firstSequence')) is not int or not 0 <= value['firstSequence'] <= 0xffffffff or
            type(value.get('firstReceivedAtMs')) is not int or not 1 <= value['firstReceivedAtMs'] <= 2**53 - 1 or
            value.get('headerIdMatched') is not True):
        raise ValueError('Invalid source identity declaration')
    return dict(value)


def merge_segments(authoritative, saved):
    """Cached snapshots never replace provider facts without an explicit edit."""
    cached = {row['id']: row for row in saved if isinstance(row, dict) and isinstance(row.get('id'), str)}
    merged = []
    for original in authoritative:
        row = dict(original)
        local = cached.get(row['id'], {})
        edits = local.get('editedFields', []) if local.get('contentEdited') is True else []
        edits = [key for key in ('source', 'speaker', 'startMs', 'endMs') if key in edits and key in local]
        if edits:
            row.update({key: local[key] for key in edits})
            row.update(contentEdited=True, editedFields=edits,
                       baseSourceRevision=local.get('baseSourceRevision'), providerSource=original.get('source', ''),
                       contentConflict=local.get('baseSourceRevision') != original.get('sourceRevision'))
            for key in ('edited', 'speakerEdited', 'timingEdited'):
                if key in local:
                    row[key] = local[key]
        if (local.get('source') == row.get('source') and
                (local.get('sourceRevision') == original.get('sourceRevision') or
                 ('source' in edits and local.get('baseSourceRevision') == original.get('sourceRevision')))):
            for key in ('translation', 'translationLanguage', 'translationRevision', 'translationFinal'):
                if key in local:
                    row[key] = local[key]
        merged.append(row)
    return merged


def bounded_segments(segments, duration_ms):
    """VAD flush padding is not part of the recording or export timeline."""
    values = []
    for segment in segments:
        row = dict(segment)
        for key in ('startMs', 'endMs'):
            if isinstance(row.get(key), (int, float)):
                if row[key] > duration_ms:
                    row['timingClampedToAudio'] = True
                row[key] = max(0, min(row[key], duration_ms))
        values.append(row)
    return values


def attach_translations(rows, translations, language):
    """A live translation rides only on the exact source revision it was made from."""
    for row in rows:
        item = translations.get(row.get('id'))
        if item and language and item['sourceRevision'] == row.get('sourceRevision'):
            row.update(translation=item['text'], translationLanguage=item.get('language', language),
                       translationRevision=item['revision'], translationFinal=True)
    return rows


async def json_object(request):
    """A request body that must be a JSON object; anything else is a 400, not a 500."""
    value = await request.json()
    if not isinstance(value, dict):
        raise ValueError('Request body must be a JSON object')
    return value


def file_asr_max_ms():
    """Longest recording whose saved WAV still fits the file-recognition upload limit."""
    return (file_asr.MAX_AUDIO_BYTES - 1 - WAV_HEADER_BYTES) // FRAME_BYTES * 20


def realtime_document_allowed(result):
    """The realtime transcript alone can make the automatic document only when the
    recording finished normally and its live text was never abandoned."""
    return bool(result.get('status') == 'completed' and result.get('segments') and
                not result.get('transcriptionDegraded'))


class Gateway:
    def __init__(self, data, token_file, origin, app_secret_file=None, base_path='', documents_config=None,
                 identity_config=None):
        self.data, self.origin = Path(data), origin.rstrip('/')
        self.base_path = normalized_base_path(base_path)
        self.app_secret_file = Path(app_secret_file) if app_secret_file else None
        self.data.mkdir(parents=True, exist_ok=True)
        os.chmod(self.data, 0o700)
        token_file = Path(token_file)
        if not token_file.exists():
            token_file.parent.mkdir(parents=True, exist_ok=True)
            with token_file.open('x') as output:
                os.chmod(token_file, 0o600)
                output.write(secrets.token_urlsafe(32))
        if token_file.stat().st_mode & 0o077:
            raise RuntimeError('Access-token file must be mode 0600')
        self.token = token_file.read_text().strip()
        if len(self.token) < 32:
            raise RuntimeError('Access token is too short')
        self.sessions, self.login_attempts = {}, {}
        self.http = None
        self.ticket, self.ticket_expires = None, 0
        self.ticket_lock = asyncio.Lock()
        # Phone stream socket -> the task running that stream (it may outlive an
        # aiohttp-cancelled handler while an accepted stop finishes).
        self.active = {}
        self.shutting_down = False
        self.speaker_tasks, self.speaker_locks = {}, {}
        self.submitting = set()  # recordings whose file-recognition submit is in flight
        self.documents_config = Path(documents_config) if documents_config else None
        self.documents = None
        self.feishu_login = FeishuLogin(self, identity_config, APP_ID) if identity_config else None

    def authorized(self, request):
        value = request.cookies.get('minutes_session', '')
        return self.sessions.get(value, 0) > time.time()

    def check_origin(self, request):
        if request.headers.get('Origin') != self.origin:
            raise web.HTTPForbidden(text='Origin is not allowed')

    def client_key(self, request):
        """Who a login attempt comes from. Behind the local tunnel every peer is
        loopback, so only then is Cloudflare's client address trusted."""
        remote = request.remote or 'unknown'
        if remote in ('127.0.0.1', '::1'):
            forwarded = request.headers.get('CF-Connecting-IP', '').strip()
            try:
                return str(ipaddress.ip_address(forwarded))
            except ValueError:
                pass
        return remote

    def limit_login(self, request):
        """Refuse a client with too many recent failed sign-ins; returns its key.
        Only failures are counted (record_login_failure), so neither malformed
        requests nor another client's failures can lock the owner out."""
        key = self.client_key(request)
        now = time.monotonic()
        recent = [t for t in self.login_attempts.get(key, []) if now - t < LOGIN_WINDOW_SECONDS]
        if recent:
            self.login_attempts[key] = recent
        else:
            self.login_attempts.pop(key, None)
        if len(recent) >= LOGIN_FAILURES:
            raise web.HTTPTooManyRequests()
        return key

    def record_login_failure(self, key):
        now = time.monotonic()
        self.login_attempts.setdefault(key, []).append(now)
        if len(self.login_attempts) > LOGIN_CLIENTS:
            for stale in [k for k, v in self.login_attempts.items() if now - v[-1] >= LOGIN_WINDOW_SECONDS]:
                del self.login_attempts[stale]
            while len(self.login_attempts) > LOGIN_CLIENTS:
                del self.login_attempts[next(iter(self.login_attempts))]

    async def login(self, request):
        self.check_origin(request)
        key = self.limit_login(request)
        body = await json_object(request)
        token = body.get('token')
        if not isinstance(token, str) or not token or len(token) > 1024:
            raise web.HTTPBadRequest(text='Invalid login request')
        if not hmac.compare_digest(token, self.token):
            self.record_login_failure(key)
            raise web.HTTPUnauthorized()
        return self.new_session()

    def new_session(self):
        self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > time.time()}
        if len(self.sessions) >= 1024:
            raise web.HTTPTooManyRequests()
        session = secrets.token_urlsafe(32)
        self.sessions[session] = time.time() + 12 * 3600
        response = web.json_response({'ok': True})
        response.set_cookie('minutes_session', session, httponly=True, secure=self.origin.startswith('https:'),
                            samesite='Strict', max_age=12 * 3600, path=self.base_path + '/')
        return response

    async def status(self, request):
        return web.json_response({'appId': APP_ID, 'privateOrigin': self.origin, 'basePath': self.base_path,
            'jsapiConfigured': bool(os.environ.get('FEISHU_APP_SECRET') or
                                    (self.app_secret_file and self.app_secret_file.is_file())),
            'provider': 'StepFun', 'model': 'stepaudio-2.5-asr-stream', 'maxSessionSeconds': 4 * 3600,
            'deviceVerified': False, 'speakerDiarization': True,
            'automaticDocuments': self.documents is not None,
            'models': {'stepfun': True, 'doubao': volc.configured()},
            'speakerAudioMaxBytes': file_asr.MAX_AUDIO_BYTES})

    def app_secret(self):
        secret = os.environ.get('FEISHU_APP_SECRET', '').strip()
        if not secret and self.app_secret_file:
            if self.app_secret_file.stat().st_mode & 0o077:
                raise RuntimeError('App-secret file must be mode 0600')
            secret = self.app_secret_file.read_text().strip()
        if not secret:
            raise ValueError('Feishu app credentials are not configured yet')
        return secret

    async def jsapi(self, request):
        self.check_origin(request)
        body = await json_object(request)
        url = signing_url(body.get('url'), self.origin, self.base_path)
        secret = self.app_secret()
        async with self.ticket_lock:
            if not self.ticket or time.time() >= self.ticket_expires:
                async with self.http.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
                    json={'app_id': APP_ID, 'app_secret': secret}) as response:
                    result = await response.json()
                if result.get('code') != 0 or not result.get('tenant_access_token'):
                    raise RuntimeError('Feishu app authentication failed; code=' + str(result.get('code')))
                async with self.http.post('https://open.feishu.cn/open-apis/jssdk/ticket/get',
                    headers={'Authorization': 'Bearer ' + result['tenant_access_token']}) as response:
                    result = await response.json()
                if result.get('code') != 0 or not result.get('data', {}).get('ticket'):
                    raise RuntimeError('Feishu JSAPI ticket request failed; code=' + str(result.get('code')))
                self.ticket = result['data']['ticket']
                self.ticket_expires = time.time() + max(0, min(7000, result['data'].get('expire_in', 7200)) - 120)
        nonce, timestamp = secrets.token_urlsafe(18), int(time.time() * 1000)
        value = 'jsapi_ticket={}&noncestr={}&timestamp={}&url={}'.format(self.ticket, nonce, timestamp, url)
        signature = hashlib.sha1(value.encode()).hexdigest()
        return web.json_response({'appId': APP_ID, 'timestamp': timestamp, 'nonceStr': nonce, 'signature': signature})

    async def text(self, request):
        self.check_origin(request)
        body = await json_object(request)
        task = request.match_info['task']
        if task not in ('summary', 'translation'):
            raise web.HTTPNotFound()
        value = await text_task(self.http, task, body.get('segments'), body.get('targetLanguage', 'en'))
        return web.json_response(value)

    async def audio(self, request):
        ident = request.match_info['id']
        if not ID.fullmatch(ident):
            raise web.HTTPNotFound()
        path = self.data / ident / 'audio.wav'
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={'Cache-Control': 'private, no-store'})

    def speaker_job(self, ident):
        if not ID.fullmatch(ident):
            raise web.HTTPNotFound()
        path = self.data / ident / 'speaker-job.json'
        return json.loads(path.read_text()) if path.is_file() else None

    def save_speaker_job(self, ident, job):
        job['updatedAt'] = iso_time(time.time())
        write_json(self.data / ident / 'speaker-job.json', job)

    async def provider_audio(self, request):
        ident, capability = request.match_info['id'], request.match_info['capability']
        job = self.speaker_job(ident)
        if (not job or not re.fullmatch(r'[A-Za-z0-9_-]{43}', capability) or
                not hmac.compare_digest(capability, job.get('capability', '')) or
                time.time() >= job.get('audioExpiresAt', 0) or
                job.get('status') in ('ready', 'applied', 'failed')):
            raise web.HTTPNotFound()
        path = self.data / ident / 'audio.wav'
        if not path.is_file() or path.stat().st_size != job.get('audioBytes'):
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={'Cache-Control': 'private, no-store',
                                               'Referrer-Policy': 'no-referrer'})

    def launch_speaker_worker(self, ident, submitting=False):
        if ident in self.speaker_tasks or self.shutting_down:
            return
        task = asyncio.create_task(self.run_speaker_job(ident, submitting))
        self.speaker_tasks[ident] = task
        def finished(value):
            if self.speaker_tasks.get(ident) is value:
                self.speaker_tasks.pop(ident, None)
        task.add_done_callback(finished)

    @staticmethod
    def speaker_job_resumable(job):
        """A job the worker should pick up again: a known task still to query, or
        an automatic application that a restart interrupted before it finished."""
        if not job:
            return False
        if job.get('status') == 'ready':
            return bool(job.get('autoApply')) and not job.get('appliedAt')
        return bool(job.get('taskId')) and job.get('status') in ('pending', 'running', 'waiting', 'query_error')

    async def run_speaker_job(self, ident, submitting=False):
        job = self.speaker_job(ident)
        if job.get('status') == 'ready':
            if job.get('autoApply') and not job.get('appliedAt'):
                await self.apply_automatic(ident)
            return
        provider = job.get('provider', 'stepfun')
        label = PROVIDER_LABELS.get(provider, 'StepFun')
        submit, query, parse = ((volc.file_submit, volc.file_query, volc.file_parse) if provider == 'doubao' else
                                (file_asr.submit, file_asr.query, file_asr.parse_result))
        try:
            if submitting:
                url = (self.origin + self.base_path + '/api/provider-audio/' + ident + '/' + job['capability'])
                self.submitting.add(ident)
                try:
                    job['taskId'] = await submit(self.http, url, job['id'])
                finally:
                    self.submitting.discard(ident)
                job['status'] = 'pending'
                self.save_speaker_job(ident, job)
            if not job.get('taskId'):
                job.update(status='uncertain', error='上次提交结果未确认，已阻止重复提交；原录音保留')
                self.save_speaker_job(ident, job)
                if job.get('autoApply'):
                    await self.finish_automatic(ident)
                return
            deadline = time.monotonic() + 30 * 60
            delay = 3
            while time.monotonic() < deadline:
                try:
                    value = await query(self.http, job['taskId'])
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    # A progress query that fails is retried here with backoff;
                    # the submitted task is never resubmitted.
                    job.update(status='query_error', error=str(error)[:250] if isinstance(error, (ValueError, RuntimeError))
                               else '进度查询中断，正在自动重试；不会重新提交')
                    self.save_speaker_job(ident, job)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 60)
                    continue
                delay = 3
                if value.get('status') in ('PENDING', 'RUNNING'):
                    job['status'] = value['status'].lower()
                    job.pop('error', None)
                    self.save_speaker_job(ident, job)
                    await asyncio.sleep(3)
                    continue
                if value.get('status') == 'FAILED':
                    job.update(status='failed', error=label + ' 文件识别失败；原录音保留，未自动重试')
                    self.save_speaker_job(ident, job)
                    if job.get('autoApply'):
                        await self.finish_automatic(ident)
                    return
                write_json(self.data / ident / 'speaker-provider-result.json', value)
                rows = parse(value, job['durationMs'], job['id'], job['language'])
                job.update(status='ready', segments=rows, segmentCount=len(rows),
                           speakerCount=len({row['speaker'] for row in rows}))
                job.pop('error', None)
                self.save_speaker_job(ident, job)
                if job.get('autoApply'):
                    await self.apply_automatic(ident)
                return
            if job.get('status') != 'query_error':
                job.update(status='waiting', error='识别仍在处理，可刷新继续查询；不会重新提交')
            self.save_speaker_job(ident, job)
        except asyncio.CancelledError:
            # Persisted task IDs can be queried after restart. A taskless
            # submission is explicitly uncertain and never resubmitted.
            raise
        except Exception as error:
            if job.get('status') in ('ready', 'applied'):
                return  # a result is saved; a later step (e.g. its document) failed, not the job
            if job.get('taskId'):
                invalid = isinstance(error, ValueError)
                job.update(status='failed' if invalid else 'query_error',
                           error=str(error)[:250] if isinstance(error, (ValueError, RuntimeError)) else
                           '进度查询中断，可刷新继续查询；不会重新提交')
            else:
                job.update(status='uncertain', error='提交结果未确认，已阻止重复提交；原录音保留')
            self.save_speaker_job(ident, job)
            if job['status'] in ('failed', 'uncertain') and job.get('autoApply'):
                # No file transcript will come: the realtime text is the document.
                await self.finish_automatic(ident)

    async def apply_automatic(self, ident):
        """A recording made with a file model takes the file transcript as its text:
        apply it, translate it, then write the document from it. The stream
        result stays in the version backup."""
        # Translate while still 'ready', so the page never fetches an applied
        # transcript without its translations or before its document is queued.
        await self.translate_applied(ident)
        async with self.speaker_locks.setdefault(ident, asyncio.Lock()):
            job = self.speaker_job(ident)
            if not job:
                return
            if job.get('status') == 'ready':
                write_json(self.data / ident / 'versions' / ('before-speakers-' + job['id'] + '.json'), self.record(ident))
                job.update(status='applied', appliedAt=iso_time(time.time()), appliedAutomatically=True)
                self.save_speaker_job(ident, job)
            elif job.get('status') != 'applied':
                return
        # Also when the owner applied it by hand meanwhile: the document still follows.
        await self.finish_automatic(ident)

    async def translate_applied(self, ident):
        job = self.speaker_job(ident)
        rows = job.get('segments', [])
        error = None
        try:
            # Each sentence goes the other way from its own language.
            for target in ('en', 'zh'):
                group = [row for row in rows if ('en' if row.get('sourceLanguage', 'zh') == 'zh' else 'zh') == target]
                for start in range(0, len(group), TRANSLATION_BATCH):
                    batch = group[start:start + TRANSLATION_BATCH]
                    value = await asyncio.wait_for(text_task(self.http, 'translation', [{
                        'id': row['id'], 'source': row['source'], 'startMs': row['startMs'], 'endMs': row['endMs']}
                        for row in batch], target), 120)
                    texts = {item['id']: item['text'][:4000] for item in value['translations']}
                    for row in batch:
                        if row['id'] in texts:
                            row.update(translation=texts[row['id']], translationLanguage=target,
                                       translationRevision=0, translationFinal=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Untranslated rows stay usable; the page offers to translate them.
            error = '译文未全部生成，可在页面里补生成'
        async with self.speaker_locks.setdefault(ident, asyncio.Lock()):
            # Translation can take minutes; only the still-unapplied result it
            # was made from takes the translations, never a newer saved state.
            current = self.speaker_job(ident)
            if not current or current.get('status') != 'ready' or current.get('id') != job.get('id'):
                return
            current['segments'] = rows
            if error:
                current['translationError'] = error
            else:
                current.pop('translationError', None)
            self.save_speaker_job(ident, current)

    def load_result(self, ident):
        path = self.data / ident / 'result.json'
        return json.loads(path.read_text()) if path.is_file() else {}

    def automatic_document_due(self, ident, result, sweep=False):
        """One rule for the automatic document, used at stop, after a file job and
        at startup. An automatically applied file transcript always makes it;
        otherwise a recording made with a file model waits until that transcript
        can no longer come, and the realtime text qualifies only when the
        recording completed with live text that was never abandoned."""
        if not self.documents or (sweep and not result.get('automaticDocument')):
            return False
        job = self.speaker_job(ident)
        if job and job.get('status') == 'applied':
            return bool(job.get('autoApply'))
        if result.get('fileModel'):
            settled = result.get('fileJobError') or (job and job.get('status') in ('failed', 'uncertain'))
            if not settled:
                return False
        return realtime_document_allowed(result)

    async def queue_automatic_document(self, ident, result=None):
        if not self.documents:
            return
        try:
            result = self.load_result(ident) if result is None else result
            if self.automatic_document_due(ident, result):
                record = self.record(ident)
                if record.get('segments'):
                    await self.documents.enqueue(record)
        except Exception as error:
            print('Automatic document not queued for %s (%s)' % (ident, type(error).__name__), flush=True)

    async def finish_automatic(self, ident):
        await self.queue_automatic_document(ident)

    async def start_automatic_file_job(self, ident, result, file_model=None):
        """Create the file job a recording asked for. `fileJobPending` marks it
        durably first, so a stop or crash in between is completed at startup."""
        try:
            await self.create_speaker_job(ident, file_model or result.get('fileModel'), auto=True)
        except Exception as error:
            result['fileJobError'] = (str(error) if isinstance(error, ValueError) else type(error).__name__)[:200]
        result.pop('fileJobPending', None)
        write_json(self.data / ident / 'result.json', result)
        if result.get('fileJobError'):
            await self.queue_automatic_document(ident, result)

    def public_speaker_job(self, ident, job=None, result=None):
        if job:
            return file_asr.public_job(job)
        result = self.load_result(ident) if result is None else result
        if result.get('fileJobError'):
            # The automatic file job could not even be created; say why.
            return {'status': 'failed', 'error': result['fileJobError'], 'submitted': False}
        return file_asr.public_job(None)

    async def get_speakers(self, request):
        ident = request.match_info['id']
        self.record(ident)
        job = self.speaker_job(ident)
        if self.speaker_job_resumable(job):
            self.launch_speaker_worker(ident)
        return web.json_response({'job': self.public_speaker_job(ident, job)})

    async def start_speakers(self, request):
        self.check_origin(request)
        ident = request.match_info['id']
        body = await json_object(request) if request.can_read_body else {}
        provider = body.get('provider', 'stepfun')
        if provider not in FILE_MODELS or (provider == 'doubao' and not volc.configured()):
            raise ValueError('所选文件识别模型不可用')
        existing = self.speaker_job(ident)
        job = await self.create_speaker_job(ident, provider)
        return web.json_response({'job': file_asr.public_job(job)}, status=200 if existing else 202)

    def file_audio_ready(self, ident, record, result=None):
        """Saved audio file recognition may use: a normally stopped recording, one
        recovered after process death, or a failed/interrupted one whose WAV was
        closed cleanly and holds exactly the frames the stream received."""
        if not (self.data / ident / 'audio.wav').is_file():
            return False
        if record.get('state') == 'stopped' or record.get('recovered'):
            return True
        result = self.load_result(ident) if result is None else result
        frames = result.get('frames')
        return (result.get('status') in ('failed', 'interrupted') and type(frames) is int and frames > 0 and
                clean_wav_bytes(self.data / ident / 'audio.wav') == frames * FRAME_BYTES)

    async def create_speaker_job(self, ident, provider='stepfun', auto=False):
        record = self.record(ident)
        lock = self.speaker_locks.setdefault(ident, asyncio.Lock())
        async with lock:
            job = self.speaker_job(ident)
            if job:
                return job
            if self.shutting_down:
                raise ValueError('服务正在重启，请稍后再提交文件识别')
            path = self.data / ident / 'audio.wav'
            if not self.file_audio_ready(ident, record):
                raise ValueError('请先完成录音并保存真实音频')
            if path.stat().st_size >= file_asr.MAX_AUDIO_BYTES:
                raise ValueError('这段音频超过文件识别的 99 MB（约 %d 分钟）上限，尚未提交；实时原稿保留'
                                 % (file_asr_max_ms() // 60000))
            with wave.open(str(path), 'rb') as audio:
                if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
                    raise ValueError('已保存音频格式不符合识别要求')
                duration_ms = round(audio.getnframes() / audio.getframerate() * 1000)
            if not duration_ms or abs(duration_ms - record['durationMs']) > 50:
                raise ValueError('已保存音频的时长未核对通过')
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            job = {'id': uuid.uuid4().hex, 'status': 'submitting', 'createdAt': iso_time(time.time()),
                   'audioSha256': digest.hexdigest(), 'audioBytes': path.stat().st_size,
                   'capability': secrets.token_urlsafe(32), 'audioExpiresAt': time.time() + 3600,
                   'durationMs': duration_ms, 'language': record.get('language', 'zh'),
                   'provider': provider, 'autoApply': bool(auto)}
            self.save_speaker_job(ident, job)
            self.launch_speaker_worker(ident, submitting=True)
            return job

    async def apply_speakers(self, request):
        self.check_origin(request)
        ident, body = request.match_info['id'], await json_object(request)
        if not ID.fullmatch(ident):
            raise web.HTTPNotFound()
        lock = self.speaker_locks.setdefault(ident, asyncio.Lock())
        async with lock:
            job, current = self.speaker_job(ident), self.record(ident)
            if not job or job.get('status') not in ('ready', 'applied'):
                raise ValueError('发言人识别结果尚未准备好')
            if job['status'] == 'applied':
                return web.json_response({'recording': current})
            if body.get('expectedContentVersion') != current['contentVersion']:
                return web.json_response({'error': '文字已在其他页面更新，请刷新后核对再应用'}, status=409)
            write_json(self.data / ident / 'versions' / ('before-speakers-' + job['id'] + '.json'), current)
            # This explicit application changes the selected source. The stream
            # result and original metadata remain in the version backup.
            job.update(status='applied', appliedAt=iso_time(time.time()))
            self.save_speaker_job(ident, job)
            return web.json_response({'recording': self.record(ident)})

    def record(self, ident):
        if not ID.fullmatch(ident):
            raise web.HTTPNotFound()
        result_path, meta_path = self.data / ident / 'result.json', self.data / '_metadata' / (ident + '.json')
        if not result_path.is_file() and not meta_path.is_file():
            raise web.HTTPNotFound()
        result = json.loads(result_path.read_text()) if result_path.is_file() else {}
        saved = json.loads(meta_path.read_text()) if meta_path.is_file() else {}
        created = result.get('startedAt', time.time())
        record = {'schemaVersion': 1, 'id': ident, 'title': result.get('title') or 'soundcore Work 录音',
                  'sourceLabel': 'soundcore Work 录音豆', 'createdAt': iso_time(created), 'updatedAt': iso_time(created),
                  'startedAt': iso_time(created), 'endedAt': iso_time(result['completedAt']) if result.get('completedAt') else None,
                  'state': 'stopped' if result.get('status') == 'completed' else 'error',
                  'durationMs': result.get('durationMs', 0), 'segments': result.get('segments', []),
                  'audioMimeType': 'audio/wav', 'summary': '', 'chapters': [],
                  'summaryStatus': 'idle', 'translationStatus': 'idle',
                  'language': result.get('language', 'zh'),
                  'sourceType': result.get('sourceType', 'live_device'), 'silenceRanges': result.get('silenceRanges', [])}
        record.update(saved)
        # Only the accepted stream declaration can supply identity. Ordinary
        # metadata edits cannot replace it, including with a stale null value.
        record['sourceIdentity'] = (result if result_path.is_file() else saved).get('sourceIdentity')
        if result.get('sourceType') == 'recorded_file_test' and 'title' not in saved:
            record['title'] = '服务链回放测试'
            record['sourceLabel'] = '已有录音回放 · 非现场录制'
        if result_path.is_file():
            # Local UI state cannot upgrade a failed or partial provider session.
            record['state'] = 'stopped' if result.get('status') == 'completed' else 'error'
            record['durationMs'] = result.get('durationMs', 0)
            record['sourceType'] = result.get('sourceType', 'live_device')
            # Audio recovered from an unclean exit is interrupted (state error)
            # but has real, playable audio that file transcription can still use.
            record['recovered'] = bool(result.get('audioRecovered'))
            record['durationLimited'] = bool(result.get('durationLimited'))
            record['transcriptionDegraded'] = bool(result.get('transcriptionDegraded'))
            # How it was recorded decides whether the page waits for a file transcript.
            record['liveModel'], record['fileModel'] = result.get('liveModel', 'stepfun'), result.get('fileModel')
            record['asrMode'] = 'post' if record['liveModel'] == 'none' else 'live'
            job = self.speaker_job(ident)
            selected = job and job.get('status') == 'applied'
            source = job['segments'] if selected else result.get('segments', [])
            record['sourceVersion'] = job['id'] if selected else 'stream'
            record['segments'] = merge_segments(bounded_segments(source, result.get('durationMs', 0)),
                                               saved.get('segments', []))
            record['speakerDiarization'] = bool(selected)
            record['speakerJob'] = self.public_speaker_job(ident, job, result)
            # Why an automatic file job was never created (e.g. over the upload limit).
            record['fileJobError'] = result.get('fileJobError')
            # Saved audio that file recognition (and so a document) can still use,
            # even when the live session ended in failure or interruption.
            record['fileAsrAvailable'] = self.file_audio_ready(ident, record, result)
            record['silenceRanges'] = result.get('silenceRanges', [])
            record['contentEdited'] = any(row.get('contentEdited') for row in record['segments'])
            if record.get('summary'):
                cached_text = [(row.get('id'), row.get('source')) for row in saved.get('segments', [])]
                current_text = [(row.get('id'), row.get('source')) for row in record['segments']]
                record['summaryStale'] = bool(record.get('summaryStale') or cached_text != current_text)
            if record['sourceType'] == 'recorded_file_test':
                record['sourceLabel'] = '已有录音回放 · 非现场录制'
        record['audioUrl'] = self.base_path + '/api/audio/' + ident if (self.data / ident / 'audio.wav').is_file() else None
        record.setdefault('sourceVersion', 'stream')
        record['contentVersion'] = file_asr.content_version(record['segments'])
        if self.documents:
            record['documentJob'] = self.documents.public(ident, record)
        return record

    async def get_document(self, request):
        ident = request.match_info['id']
        record = self.record(ident)
        return web.json_response({'job': self.documents.public(ident, record) if self.documents else {'status': 'disabled'}})

    async def start_document(self, request):
        self.check_origin(request)
        if not self.documents:
            raise ValueError('自动文档尚未配置')
        record = self.record(request.match_info['id'])
        job = await self.documents.enqueue(record, retry=True)
        return web.json_response({'job': job}, status=202)

    async def list_records(self, request):
        identifiers = {p.name for p in self.data.iterdir() if p.is_dir() and ID.fullmatch(p.name) and (p / 'result.json').is_file()}
        meta_dir = self.data / '_metadata'
        if meta_dir.is_dir():
            identifiers.update(p.stem for p in meta_dir.glob('*.json') if ID.fullmatch(p.stem))
        records = []
        for ident in identifiers:
            try:
                records.append(self.record(ident))
            except Exception as error:
                # One unreadable recording must not hide every other one.
                print('Recording %s skipped in list (%s)' % (ident, type(error).__name__), flush=True)
        records.sort(key=lambda record: str(record.get('updatedAt', '')), reverse=True)
        return web.json_response({'recordings': records})

    async def get_record(self, request):
        return web.json_response(self.record(request.match_info['id']))

    async def save_record(self, request):
        self.check_origin(request)
        value = metadata(await request.json())
        job = self.speaker_job(value['id'])
        if job and job.get('status') == 'applied' and value.get('sourceVersion') != job['id']:
            return web.json_response({'error': '发言人识别已更新原稿，请刷新后再编辑；旧内容未覆盖'}, status=409)
        result_path = self.data / value['id'] / 'result.json'
        meta_path = self.data / '_metadata' / (value['id'] + '.json')
        authority = result_path if result_path.is_file() else meta_path
        value['sourceIdentity'] = json.loads(authority.read_text()).get('sourceIdentity') if authority.is_file() else None
        write_json(meta_path, value)
        current = self.record(value['id'])
        return web.json_response({'saved': True, 'updatedAt': value['updatedAt'],
                                  'contentVersion': current['contentVersion'],
                                  'documentJob': current.get('documentJob')})

    async def diagnostic(self, request):
        self.check_origin(request)
        value = await request.json()
        if not isinstance(value, dict):
            raise ValueError('Invalid diagnostic event')
        allowed = ('at', 'recordingId', 'type', 'code', 'command', 'authenticationCode', 'diagnosticRawHex',
                   'notificationBytes', 'reassembled', 'checksumVerified', 'phase', 'deviceInfoBytes',
                   'supportAuthRaw', 'hasAuthUidRaw', 'supportAuth', 'hasAuthUid', 'api', 'platformCode',
                   'eventCount', 'advertisedCount', 'cachedCount', 'connectedCount', 'matchedCount')
        entry = {key: value[key] for key in allowed if key in value}
        if 'message' in value:
            if not isinstance(value['message'], str):
                raise ValueError('Invalid diagnostic message')
            entry['message'] = value['message'][:160]
        if len(json.dumps(entry)) > 1500:
            raise ValueError('Diagnostic event is too large')
        if 'diagnosticRawHex' in entry and not re.fullmatch(r'(?:0x)?[0-9a-fA-F]{22}', str(entry['diagnosticRawHex'])):
            raise ValueError('Only the bounded authentication diagnostic frame is allowed')
        for field, maximum in (('deviceInfoBytes', 65535), ('supportAuthRaw', 255), ('hasAuthUidRaw', 255),
                               ('eventCount', 10000), ('advertisedCount', 10000), ('cachedCount', 100),
                               ('connectedCount', 100), ('matchedCount', 100)):
            item = entry.get(field)
            if item is not None and (type(item) is not int or not 0 <= item <= maximum):
                raise ValueError('Invalid device capability diagnostic')
        if 'api' in entry and not re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,79}', str(entry['api'])):
            raise ValueError('Invalid diagnostic API name')
        if entry.get('platformCode') is not None and (type(entry['platformCode']) is not int or not -2147483648 <= entry['platformCode'] <= 2147483647):
            raise ValueError('Invalid diagnostic platform code')
        for field in ('supportAuth', 'hasAuthUid'):
            if entry.get(field) is not None and type(entry[field]) is not bool:
                raise ValueError('Invalid device capability state')
        directory = self.data / '_diagnostics'
        directory.mkdir(exist_ok=True, mode=0o700)
        path = directory / 'runtime.jsonl'
        line = json.dumps(entry, ensure_ascii=False) + '\n'
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            size = 0
        if size and size + len(line.encode('utf-8')) > DIAGNOSTIC_MAX_BYTES:
            # Bounded on disk: one previous generation is kept, older ones dropped.
            os.replace(path, directory / 'runtime.jsonl.1')
        with path.open('a') as output:
            os.chmod(path, 0o600)
            output.write(line)
        return web.json_response({'saved': True})

    async def stream(self, request):
        self.check_origin(request)
        if self.shutting_down:
            raise web.HTTPServiceUnavailable(text='Gateway is stopping')
        if len(self.active) >= 1:
            raise web.HTTPConflict(text='Another recording is already connected')
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=65536, receive_timeout=120, timeout=WS_CLOSE_TIMEOUT)
        await ws.prepare(request)
        self.active[ws] = asyncio.current_task()
        decoder = provider = wav = path = None
        result = {'status': 'initializing', 'sourceType': None, 'frames': 0, 'bytes': 0, 'sequenceGaps': 0,
                  'provider': 'StepFun', 'startedAt': time.time(), 'firstCaptionAt': None, 'sourceIdentity': None}
        ident = file_model = None
        last_sequence = None
        buffer = bytearray()
        quiet = QuietRanges()
        # Forwarding work for the provider. Audio items are bounded by `backlog`
        # (FORWARD_QUEUE_FRAMES); the single stop item always fits.
        queue = asyncio.Queue()
        backlog = 0
        initialized = asyncio.Event()
        degraded = False
        # Set once stop asks the provider to finish: from then on its closing
        # upstream is the normal end of the transcript, not a failure.
        finishing = False
        # The provider fell too far behind the saved audio; the live transcript is abandoned.
        overflowed = False
        # The phone asked to stop (or the session cap did) after every frame was
        # saved: from here the recording finishes server-side even without the phone.
        stop_accepted = False
        translations, translating = {}, set()

        async def tell(value):
            # The phone watches the recording; it does not own it. A send to a
            # socket that has gone away never decides the outcome; the reader
            # notices the disconnect.
            if ws.closed:
                return
            try:
                await ws.send_json(value)
            except ConnectionError:
                pass

        async def receive_messages():
            nonlocal last_sequence, backlog, overflowed, stop_accepted
            initial_seen = stop_seen = limit_stop = limit_warned = False
            # Validate and persist each received frame, then acknowledge it, before
            # any provider work. The bounded forwarding queue holds provider work,
            # never the only copy of audio accepted from the phone.
            async for message in ws:
                if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    return
                if not initial_seen:
                    queue.put_nowait(message)
                    initial_seen = True
                    await initialized.wait()
                    continue
                if message.type == aiohttp.WSMsgType.BINARY:
                    if stop_seen:
                        if limit_stop:
                            continue  # the phone cannot know we capped; drop extra audio, do not fail
                        raise ValueError('Audio received after stop')
                    raw = message.data
                    if len(raw) != 164:
                        raise ValueError('Expected sequence plus one complete Opus packet')
                    sequence = struct.unpack_from('<I', raw)[0]
                    if last_sequence is None and result['sourceIdentity'] is not None:
                        if sequence != result['sourceIdentity']['firstSequence']:
                            raise ValueError('Source identity does not match the first audio sequence')
                    if last_sequence is not None and sequence != last_sequence + 1:
                        result['sequenceGaps'] += 1
                        raise ValueError('Audio sequence discontinuity; no automatic replay')
                    last_sequence = sequence
                    pcm = decoder.decode(raw[4:])
                    quiet.feed(pcm)
                    wav.writeframesraw(pcm)
                    result['frames'] += 1
                    result['bytes'] += len(pcm)
                    result['lastAudioAt'] = time.time()
                    # Saved: the phone may let go of this frame now.
                    await tell({'type': 'ack', 'sequence': sequence})
                    if (file_model and not limit_warned and
                            WAV_HEADER_BYTES + result['bytes'] >= file_asr.MAX_AUDIO_BYTES):
                        limit_warned = True
                        result['fileLimitReachedAtMs'] = result['frames'] * 20
                        await tell({'type': 'status', 'phase': 'file_limit_reached', 'recordingId': ident,
                                    'message': ('已到全文识别上限（约 %d 分钟）。录音继续保存，' % (file_asr_max_ms() // 60000)) +
                                               ('结束后不会自动生成全文' if provider is None else '结束后以实时字幕为准')})
                    if backlog < FORWARD_QUEUE_FRAMES:
                        backlog += 1
                        queue.put_nowait(('audio', sequence, pcm))
                    else:
                        overflowed = True
                    if not stop_seen and result['frames'] >= MAX_SESSION_FRAMES:
                        # Reaching the configured limit finalizes and saves the
                        # recording through the ordinary stop path instead of
                        # failing it; later device audio is ignored above because
                        # the phone cannot know we capped.
                        stop_seen = limit_stop = stop_accepted = True
                        result['durationLimited'] = True
                        queue.put_nowait(('stop',))
                elif message.type == aiohttp.WSMsgType.TEXT:
                    command = json.loads(message.data)
                    if not isinstance(command, dict):
                        raise ValueError('Unknown stream command')
                    if command.get('type') == 'source_identity':
                        identity = source_identity(command, ident)
                        if result['sourceIdentity'] is not None:
                            if identity != result['sourceIdentity']:
                                raise ValueError('Source identity cannot change during a recording')
                        else:
                            if result['frames'] or result['sourceType'] != 'live_device' or stop_seen:
                                raise ValueError('Source identity must precede live device audio')
                            result['sourceIdentity'] = identity
                            write_json(path / 'result.json', result)
                            meta_path = self.data / '_metadata' / (ident + '.json')
                            saved = json.loads(meta_path.read_text()) if meta_path.is_file() else {}
                            saved['sourceIdentity'] = identity
                            write_json(meta_path, saved)
                        continue
                    if command.get('type') != 'stop':
                        raise ValueError('Unknown stream command')
                    if stop_seen:
                        continue
                    stop_seen = stop_accepted = True
                    queue.put_nowait(('stop',))

        async def process_messages():
            nonlocal decoder, provider, wav, path, ident, file_model, degraded, finishing, backlog
            initial = await asyncio.wait_for(queue.get(), 12)
            if initial.type != aiohttp.WSMsgType.TEXT:
                raise ValueError('Expected recording initialization')
            first = json.loads(initial.data)
            if not isinstance(first, dict):
                raise ValueError('Invalid recording initialization')
            ident = first.get('recordingId')
            language = first.get('language', 'zh')
            source = first.get('sourceType')
            title = first.get('title', 'soundcore Work 录音')
            live_model, requested_file_model = first.get('liveModel', 'stepfun'), first.get('fileModel')
            if (first.get('type') != 'start' or not isinstance(ident, str) or not ID.fullmatch(ident) or
                    language not in ('zh', 'en') or source not in ('live_device', 'recorded_file_test') or
                    not isinstance(title, str) or not title or len(title) > 500 or
                    live_model not in LIVE_MODELS or requested_file_model not in (None,) + FILE_MODELS or
                    (live_model == 'none' and not requested_file_model)):
                raise ValueError('Invalid recording initialization')
            if 'doubao' in (live_model, requested_file_model) and not volc.configured():
                raise ValueError('豆包识别尚未配置，请换用 StepFun')
            candidate = self.data / ident
            candidate.mkdir(mode=0o700, exist_ok=False)
            path = candidate
            result.update(recordingId=ident, sourceType=source, language=language, status='waiting_for_audio',
                          automaticDocument=bool(self.documents), title=title, liveModel=live_model,
                          fileModel=requested_file_model, provider=PROVIDER_LABELS.get(live_model))
            write_json(path / 'result.json', result)
            wav = wave.open(str(path / 'audio.wav'), 'wb')
            os.chmod(path / 'audio.wav', 0o600)
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            decoder = OpusDecoder()

            target = 'en' if language == 'zh' else 'zh'
            result['translationLanguage'] = target
            translation_slots = asyncio.Semaphore(LIVE_TRANSLATION_CONCURRENCY)

            async def translate(caption):
                # Best effort per finished sentence: a failure leaves that sentence
                # untranslated and never touches audio, captions or saving. The
                # direction follows the sentence itself, so mixed talk works.
                spoken = volc.text_language(caption['text'], language)
                into = 'en' if spoken == 'zh' else 'zh'
                try:
                    async with translation_slots:
                        value = await asyncio.wait_for(text_task(self.http, 'translation', [{
                            'id': caption['segmentId'], 'source': caption['text'],
                            'startMs': caption['startMs'], 'endMs': caption['endMs']}], into), LIVE_TRANSLATION_TIMEOUT)
                    text = value['translations'][0]['text'][:4000]
                    known = translations.get(caption['segmentId'])
                    if known and known['sourceRevision'] > caption['revision']:
                        return
                    item = {'text': text, 'sourceRevision': caption['revision'], 'language': into,
                            'revision': known['revision'] + 1 if known else 0}
                    translations[caption['segmentId']] = item
                    await tell({'type': 'translation', 'recordingId': ident, 'event': {
                        'type': 'translation', 'segmentId': caption['segmentId'], 'sourceRevision': caption['revision'],
                        'revision': item['revision'], 'language': into, 'text': text, 'final': True}})
                except asyncio.CancelledError:
                    raise
                except Exception:
                    result['translationFailures'] = result.get('translationFailures', 0) + 1

            async def emit(caption):
                if result['firstCaptionAt'] is None:
                    result['firstCaptionAt'] = time.time()
                await tell({'type': 'caption', 'recordingId': ident, 'event': caption})
                if caption['final'] and caption['text'].strip():
                    task = asyncio.create_task(translate(caption))
                    translating.add(task)
                    task.add_done_callback(translating.discard)

            provider = (VolcStream(self.http, language, emit) if live_model == 'doubao' else
                        StepStream(self.http, language, emit) if live_model == 'stepfun' else None)
            label = PROVIDER_LABELS.get(live_model, '')

            async def degrade():
                # A stalled or unreachable provider must not end the recording:
                # keep capturing, keep acking, and finish from the file afterwards.
                # A hard provider rejection is not a stall and still fails loud.
                # Closing the provider is why monitor_provider checks `degraded`
                # before treating the close as a failure.
                nonlocal degraded
                if degraded:
                    return
                degraded = True
                result['transcriptionDegraded'] = True
                buffer.clear()
                await tell({'type': 'status', 'phase': 'transcription_degraded', 'recordingId': ident,
                            'message': '实时转写暂时跟不上，录音继续；结束后可用文件转写补全完整文字'})
                try:
                    await asyncio.wait_for(provider.close(), PROVIDER_CLOSE_SECONDS)
                except Exception:
                    pass

            await tell({'type': 'ready', 'recordingId': ident, 'fileAsrMaxMs': file_asr_max_ms()})
            # The reader starts saving and acknowledging audio only after `ready`.
            file_model = requested_file_model
            initialized.set()
            while True:
                work = await queue.get()
                if work[0] == 'audio':
                    backlog -= 1
                    _, sequence, pcm = work
                    if provider is None and result['status'] == 'waiting_for_audio':
                        result['status'] = 'streaming'
                        await tell({'type': 'status', 'phase': 'recording', 'recordingId': ident,
                                    'message': '正在录音，录完后识别全文并区分发言人（全文识别上限约 %d 分钟）'
                                               % (file_asr_max_ms() // 60000)})
                    if provider and not degraded and overflowed:
                        await degrade()
                    if provider and not degraded:
                        try:
                            if not provider.ws:
                                await tell({'type': 'status', 'phase': 'connecting_asr', 'recordingId': ident,
                                            'message': '已收到设备音频，正在连接 ' + label})
                                await asyncio.wait_for(provider.open(), PROVIDER_OPEN_TIMEOUT)
                                result['status'] = 'streaming'
                                await tell({'type': 'status', 'phase': 'recording', 'recordingId': ident,
                                            'message': '录音豆音频已接入 ' + label})
                            buffer.extend(pcm)
                            while len(buffer) >= 3200:
                                await asyncio.wait_for(provider.append(bytes(buffer[:3200])), PROVIDER_APPEND_TIMEOUT)
                                del buffer[:3200]
                        except DEGRADABLE_PROVIDER_ERRORS:
                            await degrade()  # stall or lost connection; provider rejections still propagate
                elif work[0] == 'stop':
                    if not result['frames']:
                        raise ValueError('No device audio was received')
                    if provider and not degraded and overflowed:
                        await degrade()
                    if provider and not degraded and buffer:
                        try:
                            await asyncio.wait_for(provider.append(bytes(buffer)), PROVIDER_APPEND_TIMEOUT)
                            buffer.clear()
                        except DEGRADABLE_PROVIDER_ERRORS:
                            await degrade()
                    if provider and not degraded:
                        await tell({'type': 'status', 'phase': 'finishing', 'recordingId': ident,
                                    'message': '正在等待最后一句确认'})
                        finishing = True
                        segments = bounded_segments(await provider.finish(), result['frames'] * 20)
                    elif provider:
                        segments = bounded_segments(provider.transcript.segments(), result['frames'] * 20)
                    else:
                        segments = []
                    if translating:
                        await asyncio.wait(set(translating), timeout=LIVE_TRANSLATION_FINISH_SECONDS)
                    segments = attach_translations(segments, translations, target)
                    wav.close()
                    wav = None
                    result.update(status='completed', durationMs=result['frames'] * 20,
                                  deltaEvents=provider.transcript.delta_events if provider else 0,
                                  finalEvents=provider.transcript.final_events if provider else 0,
                                  timingEvents=provider.transcript.timing_events if provider else [],
                                  completedAt=time.time(), segments=segments,
                                  silenceRanges=quiet.finish(), silenceMethod='pcm_rms_below_128_minimum_500ms_margin_100ms',
                                  textBeforeLastAudio=bool(result['firstCaptionAt'] and result['firstCaptionAt'] < result['lastAudioAt']))
                    if file_model:
                        result['fileJobPending'] = True
                    write_json(path / 'result.json', result)
                    # Durable follow-up work comes before telling the phone, which
                    # may close as soon as it hears `complete`.
                    if file_model:
                        if not self.shutting_down:
                            await self.start_automatic_file_job(ident, result, file_model)
                    else:
                        await self.queue_automatic_document(ident, result)
                    await tell({'type': 'complete', 'recordingId': ident, 'durationMs': result['durationMs'],
                                'audio': {'url': self.base_path + '/api/audio/' + ident, 'mimeType': 'audio/wav'},
                                'segments': segments, 'silenceRanges': result['silenceRanges'],
                                'durationLimited': bool(result.get('durationLimited')),
                                'transcriptionDegraded': degraded, 'fileModel': file_model})
                    break

        async def monitor_provider():
            await initialized.wait()
            if provider is None:
                # Audio-only recording: nothing upstream can fail mid-recording.
                await asyncio.Event().wait()
            await provider.stopped.wait()
            if degraded or finishing:
                # Degradation closed the provider on purpose, and Doubao closes
                # its upstream after the final result; neither is a failure
                # (finish() itself raises if the end was not clean). Hold until
                # the recording stops or is torn down.
                await asyncio.Event().wait()
            provider.check()
            raise RuntimeError('ASR connection closed before completion')

        def phone_violation():
            """A reader failure that decides the outcome. After an accepted stop,
            only a protocol violation does; a lost or timed-out phone does not."""
            if not reader.done() or reader.cancelled():
                return None
            error = reader.exception()
            if error is None or (stop_accepted and not isinstance(error, ValueError)):
                return None
            return error

        async def finish_after_stop():
            # Bounded: STOP_FINISH_SECONDS normally, SHUTDOWN_FINISH_SECONDS once
            # the service is stopping, so a stop never outlives the unit's budget.
            loop = asyncio.get_running_loop()
            deadline, stopping_deadline = loop.time() + STOP_FINISH_SECONDS, None
            while not processor.done() and not monitor.done():
                now = loop.time()
                if self.shutting_down and stopping_deadline is None:
                    stopping_deadline = now + SHUTDOWN_FINISH_SECONDS
                limit = min(deadline, stopping_deadline or deadline)
                if now >= limit:
                    result['finishTimedOut'] = True
                    return
                await asyncio.wait((processor, monitor), timeout=min(limit - now, 0.25),
                                   return_when=asyncio.FIRST_COMPLETED)

        reader = asyncio.create_task(receive_messages())
        processor = asyncio.create_task(process_messages())
        monitor = asyncio.create_task(monitor_provider())
        cancelled = False
        try:
            try:
                await asyncio.wait((reader, processor, monitor), return_when=asyncio.FIRST_COMPLETED)
            except asyncio.CancelledError:
                # aiohttp cancels the handler when the phone's connection drops.
                cancelled = True
            if stop_accepted and not processor.done() and not monitor.done() and phone_violation() is None:
                await finish_after_stop()
            if processor.done():
                processor.result()
            elif monitor.done():
                monitor.result()
            elif phone_violation() is not None:
                raise phone_violation()
            elif result['status'] != 'completed':
                result['status'] = 'interrupted'
            if cancelled:
                raise asyncio.CancelledError()
        except asyncio.CancelledError:
            if result['status'] != 'completed':
                result['status'] = 'interrupted'
            raise
        except Exception as error:
            if result['status'] != 'completed':
                result['status'] = 'failed'
            result['errorType'] = type(error).__name__
            # Only our own bounded messages are safe; transport exceptions may include URLs.
            detail = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
            result['error'] = detail[:300]
            await tell({'type': 'error', 'recordingId': ident, 'message': result['error']})
        finally:
            try:
                for task in (reader, processor, monitor, *translating):
                    task.cancel()
                await asyncio.gather(reader, processor, monitor, *translating, return_exceptions=True)
                try:
                    if provider:
                        await asyncio.wait_for(provider.close(), SHUTDOWN_PROVIDER_CLOSE_SECONDS
                                               if self.shutting_down else PROVIDER_CLOSE_SECONDS)
                except Exception:
                    pass  # a provider that will not close cleanly never blocks saving
                finally:
                    if provider and result['status'] != 'completed':
                        result['segments'] = attach_translations(
                            bounded_segments(provider.transcript.segments(), result['frames'] * 20),
                            translations, result.get('translationLanguage'))
                    try:
                        if decoder:
                            decoder.close()
                    finally:
                        try:
                            if wav:
                                wav.close()
                        finally:
                            if path:
                                result['durationMs'] = result['frames'] * 20
                                if (result['status'] != 'completed' and file_model and
                                        not (path / 'speaker-job.json').is_file() and result['frames'] and
                                        clean_wav_bytes(path / 'audio.wav') == result['frames'] * FRAME_BYTES):
                                    # Captured audio stays transcribable after a failed or
                                    # interrupted live session.
                                    result['fileJobPending'] = True
                                write_json(path / 'result.json', result)
                if (path and result.get('fileJobPending') and not self.shutting_down and
                        not (path / 'speaker-job.json').is_file()):
                    await self.start_automatic_file_job(ident, result, file_model)
            finally:
                self.active.pop(ws, None)
                await ws.close()
        return ws

    async def static(self, request):
        name = request.match_info.get('path') or 'h5/index.html'
        relative = Path(name)
        if '..' in relative.parts or relative.is_absolute() or relative.parts[0] in ('server', 'test'):
            raise web.HTTPNotFound()
        path = (ROOT / relative).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file() or path.suffix not in ('.html', '.js', '.css', '.svg', '.png', '.jpg'):
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={'Cache-Control': 'no-store'})

    async def shutdown(self, app):
        """Service stop (aiohttp on_shutdown, before its own handler wait).

        Each phone stream is closed with 1001 so its own teardown saves the
        recording; an accepted stop gets a short, bounded chance to finish.
        In-flight file-recognition submits and document creates may complete
        briefly (they cannot be safely repeated); everything else is cancelled
        with its durable state already on disk. Bounded to fit TimeoutStopSec."""
        self.shutting_down = True
        streams = [task for task in self.active.values() if task and not task.done()]
        closers = [asyncio.ensure_future(ws.close(code=1001, message=b'Gateway stopping')) for ws in list(self.active)]
        in_flight = [self.speaker_tasks[ident] for ident in list(self.submitting) if ident in self.speaker_tasks]
        if self.documents and hasattr(self.documents, 'in_flight'):
            in_flight += self.documents.in_flight()

        async def settle(tasks, seconds):
            if tasks:
                await asyncio.wait(tasks, timeout=seconds)
        await asyncio.gather(settle(streams, SHUTDOWN_STREAM_SECONDS), settle(in_flight, SHUTDOWN_TASK_SECONDS))
        remaining = [task for task in streams + closers + list(self.speaker_tasks.values()) if not task.done()]
        for task in remaining:
            task.cancel()
        if self.documents and hasattr(self.documents, 'cancel_all'):
            remaining += self.documents.cancel_all()
        if remaining:
            await asyncio.wait(remaining, timeout=1)

    async def cleanup(self, app):
        # Normally already done by shutdown(); kept for runners that skip it.
        for ws in list(self.active):
            await ws.close(code=1001, message=b'Gateway stopping')
        jobs = list(self.speaker_tasks.values())
        for task in jobs:
            task.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        if self.documents:
            await self.documents.close()
        await self.http.close()

    def recover_recordings(self):
        """Make recordings cut short by process death playable again.

        A normal teardown closes the WAV; only an unclean exit (force kill,
        power loss, crash) leaves a captured file with a stale header. Grow the
        header to the real audio, record the recovery, and set the true duration
        so the session can be played back and still transcribed from the file.
        The transcript is never fabricated: a recovered recording keeps whatever
        realtime segments survived (usually none) and stays out of the completed
        state. The pass is idempotent — once repaired the header matches, so a
        later restart grows nothing and rewrites nothing."""
        recovered = []
        for result_path in sorted(self.data.glob('*/result.json')):
            ident = result_path.parent.name
            if not ID.fullmatch(ident):
                continue
            try:
                result = json.loads(result_path.read_text())
                if result.get('status') == 'completed':
                    continue
                duration = recover_wav_header(result_path.parent / 'audio.wav')
                if not duration:
                    continue
                result.update(audioRecovered=True, recoveredAudioMs=duration, durationMs=duration,
                              recoveredAt=iso_time(time.time()))
                result['frames'] = max(result.get('frames') or 0, duration // 20)
                write_json(result_path, result)
                recovered.append(ident)
            except Exception as error:
                self.skipped('recovery', ident, error)
        return recovered

    @staticmethod
    def skipped(phase, ident, error):
        # The recording id and exception type only; never contents or paths with secrets.
        print('Startup %s skipped recording %s (%s)' % (phase, ident, type(error).__name__), flush=True)

    async def startup(self, app):
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=40), trust_env=True)
        self.recover_recordings()
        if self.documents_config:
            config = json.loads(self.documents_config.read_text())
            if (not self.app_secret_file or not isinstance(config.get('ownerUserId'), str) or
                    not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', config['ownerUserId']) or
                    not re.fullmatch(r'https://[a-z0-9-]+\.feishu\.cn', config.get('docBaseUrl', ''))):
                raise ValueError('Invalid private document configuration')
            self.documents = feishu_docs.Publisher(self, config,
                feishu_docs.Client(self.http, APP_ID, self.app_secret_file), text_task)
            for path in sorted(self.data.glob('*/document-job.json')):
                ident = path.parent.name
                try:
                    if ID.fullmatch(ident) and self.documents.load(ident)['status'] in feishu_docs.ACTIVE:
                        self.documents.launch(ident)
                except Exception as error:
                    self.skipped('document resume', ident, error)
        # Speaker jobs first: marking an unconfirmed submit uncertain settles the
        # file transcript, which the document pass below relies on.
        for path in sorted(self.data.glob('*/speaker-job.json')):
            ident = path.parent.name
            if not ID.fullmatch(ident):
                continue
            try:
                job = self.speaker_job(ident)
                if self.speaker_job_resumable(job):
                    self.launch_speaker_worker(ident)
                elif job.get('status') not in ('ready', 'applied', 'failed', 'uncertain'):
                    job.update(status='uncertain', error='服务重启前的提交结果未确认，已阻止重复提交')
                    self.save_speaker_job(ident, job)
            except Exception as error:
                self.skipped('speaker resume', ident, error)
        for path in sorted(self.data.glob('*/result.json')):
            ident = path.parent.name
            if not ID.fullmatch(ident):
                continue
            try:
                result = json.loads(path.read_text())
                if result.get('fileJobPending') and not (path.parent / 'speaker-job.json').is_file():
                    # A stop or crash came between saving the recording and creating its file job.
                    await self.start_automatic_file_job(ident, result)
                elif (self.documents and not self.documents.load(ident) and
                        self.automatic_document_due(ident, result, sweep=True)):
                    record = self.record(ident)
                    if record.get('segments'):
                        await self.documents.enqueue(record)
            except Exception as error:
                self.skipped('automatic follow-up', ident, error)

    def application(self):
        @web.middleware
        async def boundary(request, handler):
            if request.host != urlsplit(self.origin).netloc:
                raise web.HTTPForbidden(text='Host is not allowed')
            path = request.path
            if self.base_path:
                if path == self.base_path:
                    raise web.HTTPFound(self.base_path + '/')
                if not path.startswith(self.base_path + '/'):
                    raise web.HTTPNotFound()
                path = path[len(self.base_path):]
            try:
                if path == '/healthz':
                    return web.json_response({'service': 'minutes-private-gateway'})
                if path == '/login':
                    destination = self.base_path + '/h5/index.html'
                    ident = request.query.get('recording', '')
                    if ID.fullmatch(ident):
                        destination = self.base_path + '/preview.html?recording=' + ident
                    if self.authorized(request):
                        raise web.HTTPFound(destination)
                    if self.feishu_login:
                        return self.feishu_login.page(request, destination)
                    return web.Response(text=LOGIN.replace('__MINUTES_BASE__', json.dumps(self.base_path)).replace(
                                            '__MINUTES_DESTINATION__', json.dumps(destination)),
                                        content_type='text/html')
                if self.feishu_login and path == '/auth/feishu-login.js':
                    return web.FileResponse(ROOT / 'h5/feishu-login.js', headers={
                        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                        'Content-Type': 'text/javascript; charset=utf-8'})
                public_login = path == '/api/session' or (self.feishu_login and path == '/api/feishu-session')
                if not public_login and not path.startswith('/api/provider-audio/') and not self.authorized(request):
                    if path.startswith('/api/'):
                        raise web.HTTPUnauthorized(text='Private session required')
                    ident = request.query.get('recording', '')
                    suffix = '?recording=' + ident if path == '/preview.html' and ID.fullmatch(ident) else ''
                    raise web.HTTPFound(self.base_path + '/login' + suffix)
                response = await handler(request)
            except (ValueError, RuntimeError) as error:
                response = web.json_response({'error': str(error)[:300]}, status=400)
            response.headers['Referrer-Policy'] = 'no-referrer'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            response.headers['Cache-Control'] = 'no-store'
            return response

        app = web.Application(middlewares=[boundary], client_max_size=1024**2)
        app.router.add_post(self.base_path + '/api/session', self.login)
        if self.feishu_login:
            app.router.add_post(self.base_path + '/api/feishu-session', self.feishu_login.login)
        app.router.add_get(self.base_path + '/api/status', self.status)
        app.router.add_post(self.base_path + '/api/jsapi-config', self.jsapi)
        app.router.add_get(self.base_path + '/api/stream', self.stream)
        app.router.add_get(self.base_path + '/api/audio/{id}', self.audio)
        app.router.add_get(self.base_path + '/api/provider-audio/{id}/{capability}', self.provider_audio)
        app.router.add_get(self.base_path + '/api/recordings/{id}/speakers', self.get_speakers)
        app.router.add_post(self.base_path + '/api/recordings/{id}/speakers', self.start_speakers)
        app.router.add_post(self.base_path + '/api/recordings/{id}/speakers/apply', self.apply_speakers)
        app.router.add_get(self.base_path + '/api/recordings/{id}/document', self.get_document)
        app.router.add_post(self.base_path + '/api/recordings/{id}/document', self.start_document)
        app.router.add_get(self.base_path + '/api/recordings', self.list_records)
        app.router.add_get(self.base_path + '/api/recordings/{id}', self.get_record)
        app.router.add_post(self.base_path + '/api/recordings', self.save_record)
        app.router.add_post(self.base_path + '/api/diagnostics', self.diagnostic)
        app.router.add_post(self.base_path + '/api/text/{task}', self.text)
        app.router.add_get(self.base_path + '/{path:.*}', self.static)
        app.on_startup.append(self.startup)
        app.on_shutdown.append(self.shutdown)
        app.on_cleanup.append(self.cleanup)
        return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8897)
    parser.add_argument('--origin', default='http://127.0.0.1:8897')
    parser.add_argument('--base-path', default='')
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--access-token-file', type=Path, required=True)
    parser.add_argument('--app-secret-file', type=Path)
    parser.add_argument('--documents-config', type=Path)
    parser.add_argument('--identity-config', type=Path)
    args = parser.parse_args()
    if (args.app_secret_file or args.identity_config or args.documents_config or
            os.environ.get('FEISHU_APP_SECRET')) and not re.fullmatch(r'cli_[A-Za-z0-9]+', APP_ID):
        parser.error('Set FEISHU_APP_ID to your own Feishu application ID before enabling Feishu integration')
    gateway = Gateway(args.data, args.access_token_file, args.origin, args.app_secret_file, args.base_path,
                      args.documents_config, args.identity_config)
    web.run_app(gateway.application(), host=args.bind, port=args.port, access_log=None, handler_cancellation=True,
                shutdown_timeout=SHUTDOWN_TIMEOUT,
                print=lambda _: print('Private gateway listening; credentials omitted', flush=True))
