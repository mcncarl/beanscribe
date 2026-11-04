"""Bounded file ASR requests; the caller owns durable submission state.

No retries live here: a missing submission response may still have been billed.
The provider receives only a temporary capability for one selected WAV file.
"""
import hashlib
import json
import math

import aiohttp

from stepfun import credential
from volc import text_language

BASE = 'https://api.stepfun.com/v1/audio/asr/file/'
MODEL = 'stepaudio-2.5-asr'
MAX_AUDIO_BYTES = 99_000_000


def content_version(segments):
    fields = ('id', 'source', 'speaker', 'startMs', 'endMs')
    value = [{key: row.get(key) for key in fields} for row in segments]
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


async def submit(http, audio_url, request_id):
    payload = {'audio': {'format': 'wav', 'url': audio_url},
               'request': {'model_name': MODEL, 'show_utterances': True,
                           'enable_speaker_info': True}}
    async with http.post(BASE + 'submit', json=payload,
                         headers={'Authorization': 'Bearer ' + credential(),
                                  'X-Request-Id': request_id},
                         timeout=aiohttp.ClientTimeout(total=40)) as response:
        if response.status != 200:
            raise RuntimeError('文件识别提交未确认（HTTP ' + str(response.status) + '），未自动重试')
        value = await response.json()
    task = value.get('task_id')
    if not isinstance(task, str) or not task or len(task) > 200:
        raise RuntimeError('文件识别未返回任务编号，未自动重试')
    return task


async def query(http, task):
    async with http.post(BASE + 'query', json={'task_id': task},
                         headers={'Authorization': 'Bearer ' + credential()},
                         timeout=aiohttp.ClientTimeout(total=40)) as response:
        if response.status != 200:
            raise RuntimeError('文件识别进度暂不可用（HTTP ' + str(response.status) + '）')
        return await response.json()


def parse_result(value, duration_ms, job_id, language='zh'):
    """Only provider utterances create speaker identity; no guessed splits."""
    groups = value.get('result')
    if not isinstance(groups, list) or not groups:
        raise ValueError('文件识别没有返回分句结果')
    rows, names = [], {}
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('utterances'), list):
            raise ValueError('文件识别缺少分句与发言人信息')
        for utterance in group['utterances']:
            if not isinstance(utterance, dict):
                raise ValueError('文件识别分句格式无效')
            text = utterance.get('text')
            start, end = utterance.get('start_time'), utterance.get('end_time')
            speaker = utterance.get('speaker')
            speaker_id = speaker.get('id') if isinstance(speaker, dict) else None
            if (not isinstance(text, str) or len(text) > 2000 or
                    not isinstance(speaker_id, str) or not speaker_id or len(speaker_id) > 100):
                raise ValueError('文件识别没有完整返回真实发言人标记')
            if not text.strip():
                continue
            if any(isinstance(t, bool) or not isinstance(t, (int, float)) or
                   not math.isfinite(t) for t in (start, end)) or start < 0 or end <= start:
                raise ValueError('文件识别时间戳无效')
            # Small encoder/tail rounding is bounded to the actual saved audio.
            if start >= duration_ms or end > duration_ms + 2000:
                raise ValueError('文件识别时间与已保存音频不一致')
            names.setdefault(speaker_id, '发言人 ' + str(len(names) + 1))
            rows.append({'id': 'file-' + job_id + '-' + str(len(rows)),
                         'source': text, 'sourceLanguage': text_language(text, language), 'sourceRevision': 0,
                         'sourceFinal': True, 'startMs': round(start),
                         'endMs': min(duration_ms, round(end)),
                         'speaker': names[speaker_id], 'providerSpeakerId': speaker_id})
    if not rows or len(rows) > 20000 or len(names) > 10:
        raise ValueError('文件识别分句或发言人数量无效')
    rows.sort(key=lambda row: (row['startMs'], row['endMs']))
    return rows


def public_job(job):
    if not job:
        return {'status': 'idle'}
    keys = ('status', 'createdAt', 'updatedAt', 'appliedAt', 'error', 'speakerCount', 'segmentCount')
    result = {key: job[key] for key in keys if key in job}
    if job.get('status') == 'ready':
        result['preview'] = [{'speaker': row['speaker'], 'text': row['source'],
                              'startMs': row['startMs'], 'endMs': row['endMs']}
                             for row in job.get('segments', [])[:8]]
    return result
