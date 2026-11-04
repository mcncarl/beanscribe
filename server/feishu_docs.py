"""Durable, private Docx publication for completed recordings.

Only the configured app's new documents are used. Creation has no documented
idempotency key: an ambiguous create is quarantined rather than repeated.
"""
import asyncio
import hashlib
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiohttp

API = 'https://open.feishu.cn/open-apis'
PRIVATE = {'external_access': False, 'link_share_entity': 'closed',
           'share_entity': 'only_full_access', 'invite_external': False}
ACTIVE = ('queued', 'summarizing', 'creating', 'securing', 'writing', 'verifying', 'retrying')


class ApiError(RuntimeError):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__('飞书文档接口失败（code=%s，HTTP=%s）' % (code, status))


class UncertainCreate(RuntimeError):
    pass


class ContentConflict(RuntimeError):
    pass


def version(record):
    value = {'title': record.get('title'), 'segments': [
        {key: row.get(key) for key in ('id', 'source', 'speaker', 'startMs', 'endMs')}
        for row in record.get('segments', [])]}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def text_block(text, kind='text'):
    return {'block_type': {'text': 2, 'heading1': 3, 'heading2': 4, 'bullet': 12}[kind],
            kind: {'elements': [{'text_run': {'content': text}}]}}


def block_text(block):
    kind = {2: 'text', 3: 'heading1', 4: 'heading2', 12: 'bullet'}.get(block.get('block_type'))
    if not kind:
        raise ContentConflict('飞书文档已有其他内容，已停止写入并保留现状')
    return (block['block_type'], ''.join(item.get('text_run', {}).get('content', '')
                                        for item in block.get(kind, {}).get('elements', [])))


def time_label(ms):
    if not isinstance(ms, (int, float)):
        return '--:--'
    seconds = max(0, int(ms // 1000))
    return '%02d:%02d' % (seconds // 60, seconds % 60)


def build_blocks(record, summary):
    blocks = [text_block(summary.get('title') or record.get('title') or '录音纪要', 'heading1'),
              text_block('录音时间：%s · 时长：%s · StepFun 转写与总结' %
                         (record.get('createdAt', ''), time_label(record.get('durationMs')))),
              text_block('总结', 'heading1')]
    for line in summary['summary'].splitlines():
        line = line.strip()
        if not line:
            continue
        kind = 'heading2' if line.startswith('#') else 'bullet' if line.startswith(('- ', '* ')) else 'text'
        line = line.lstrip('#').strip() if kind == 'heading2' else line[2:] if kind == 'bullet' else line
        for offset in range(0, len(line), 1800):
            blocks.append(text_block(line[offset:offset + 1800], kind))
    chapters = summary.get('chapters', [])
    if chapters:
        blocks.append(text_block('章节回顾', 'heading1'))
        for chapter in chapters:
            blocks.append(text_block(time_label(chapter.get('startMs')) + '  ' + chapter['title'], 'bullet'))
    blocks.extend([text_block('完整文字记录', 'heading1'),
                   text_block('以下文字来自已保存的转写；未经识别的说话人不据切段数量推定身份。')])
    for row in record['segments']:
        blocks.append(text_block('%s  %s' % (time_label(row.get('startMs')), row.get('speaker', '发言人')), 'heading2'))
        for offset in range(0, len(row['source']), 1800):
            blocks.append(text_block(row['source'][offset:offset + 1800]))
    return blocks


class Client:
    def __init__(self, http, app_id, secret_file):
        self.http, self.app_id, self.secret_file = http, app_id, Path(secret_file)
        self.token, self.expires = None, 0
        self.lock = asyncio.Lock()

    async def authenticate(self):
        async with self.lock:
            if self.token and time.time() < self.expires:
                return self.token
            if self.secret_file.stat().st_mode & 0o077:
                raise RuntimeError('App-secret file must be mode 0600')
            async with self.http.post(API + '/auth/v3/tenant_access_token/internal', json={
                    'app_id': self.app_id, 'app_secret': self.secret_file.read_text().strip()}) as response:
                value = await response.json()
            if value.get('code') != 0 or not value.get('tenant_access_token'):
                raise ApiError(value.get('code'), response.status)
            self.token = value['tenant_access_token']
            self.expires = time.time() + min(value.get('expire', 7200), 7000) - 120
            return self.token

    async def request(self, method, path, body=None, params=None):
        token = await self.authenticate()
        async with self.http.request(method, API + path, json=body, params=params,
                                     headers={'Authorization': 'Bearer ' + token}) as response:
            if response.status >= 500:
                raise aiohttp.ClientError('Feishu server response is ambiguous')
            value = await response.json()
            if response.status != 200 or value.get('code') != 0:
                raise ApiError(value.get('code', 'unknown'), response.status)
            return value.get('data', {})

    async def create(self, title):
        value = await self.request('POST', '/docx/v1/documents', {'title': title})
        ident = value.get('document', {}).get('document_id')
        if not isinstance(ident, str) or not ident.isalnum():
            raise UncertainCreate('飞书可能已创建文档，但未返回有效文档标识；已阻止重复创建')
        return ident

    async def secure(self, ident, owner):
        path = '/drive/v1/permissions/' + ident + '/public'
        await self.request('PATCH', path, PRIVATE, {'type': 'docx'})
        value = await self.request('GET', path, params={'type': 'docx'})
        setting = value.get('permission_public', {})
        if any(setting.get(key) != expected for key, expected in PRIVATE.items()):
            raise RuntimeError('文档私有权限尚未核验，正文没有写入')
        # userid is tenant-scoped; open_id from another application must not be reused.
        await self.request('POST', '/drive/v1/permissions/' + ident + '/members',
                           {'member_type': 'userid', 'member_id': owner, 'perm': 'full_access', 'type': 'user'},
                           {'type': 'docx', 'need_notification': 'false'})

    async def children(self, ident):
        values, cursor = [], None
        while True:
            params = {'page_size': '500'}
            if cursor:
                params['page_token'] = cursor
            value = await self.request('GET', '/docx/v1/documents/%s/blocks/%s/children' % (ident, ident), params=params)
            values.extend(value.get('items', []))
            if not value.get('has_more'):
                return values
            cursor = value.get('page_token')
            if not cursor:
                raise RuntimeError('文档回读分页不完整')

    async def append(self, ident, blocks, token):
        return await self.request('POST', '/docx/v1/documents/%s/blocks/%s/children' % (ident, ident),
                                  {'children': blocks, 'index': -1},
                                  {'document_revision_id': '-1', 'client_token': token})


class Publisher:
    def __init__(self, gateway, config, client, summarize):
        self.gateway, self.config, self.client, self.summarize = gateway, config, client, summarize
        self.tasks = {}
        self.locks = {}
        self.creating = set()  # documents whose create request is in flight

    def load(self, ident):
        path = self.gateway.data / ident / 'document-job.json'
        return json.loads(path.read_text()) if path.is_file() else None

    def save(self, ident, job):
        from gateway import write_json, iso_time
        job['updatedAt'] = iso_time(time.time())
        write_json(self.gateway.data / ident / 'document-job.json', job)

    def public(self, ident, record=None):
        job = self.load(ident)
        if not job:
            if record and record.get('state') == 'stopped' and record.get('audioUrl') and not record.get('segments'):
                return {'status': 'no_text'}
            return {'status': 'idle'}
        result = {key: job[key] for key in ('status', 'error', 'updatedAt', 'documentId', 'url', 'attempts') if key in job}
        if isinstance(job.get('summary'), dict) and job['summary'].get('title'):
            result['title'] = job['summary']['title']
        if record is not None:
            result['stale'] = job['contentVersion'] != version(record)
        return result

    async def enqueue(self, record, retry=False):
        ident = record['id']
        async with self.locks.setdefault(ident, asyncio.Lock()):
            job = self.load(ident)
            if job:
                if retry and job['status'] == 'failed':
                    job.update(status='queued', attempts=0)
                    job.pop('error', None)
                    self.save(ident, job)
                elif job['status'] not in ACTIVE:
                    return self.public(ident, record)
            else:
                # A recording whose live session ended badly still qualifies once
                # the file transcript of its complete saved audio is applied.
                finished = record['state'] == 'stopped' or (
                    record.get('speakerDiarization') is True and record.get('fileAsrAvailable') is True)
                if not finished or not record.get('segments') or not record.get('audioUrl'):
                    raise ValueError('请先完成录音，保存音频与文字')
                snapshot = {key: record.get(key) for key in ('id', 'title', 'createdAt', 'durationMs', 'segments')}
                job = {'id': uuid.uuid4().hex, 'status': 'queued', 'attempts': 0,
                       'contentVersion': version(record), 'record': snapshot, 'batchTokens': {}}
                self.save(ident, job)
            self.launch(ident)
            return self.public(ident, record)

    def launch(self, ident):
        # During service stop a queued job stays queued on disk; startup resumes it.
        if ident not in self.tasks and not getattr(self.gateway, 'shutting_down', False):
            task = asyncio.create_task(self.run(ident))
            self.tasks[ident] = task
            task.add_done_callback(lambda done: self.tasks.pop(ident, None))

    async def run(self, ident):
        job = self.load(ident)
        if job.get('createPending') and not job.get('documentId'):
            job.update(status='uncertain', error='上次创建文档的结果未确认；已阻止重复创建，需要核对飞书中的文档')
            self.save(ident, job)
            return
        for attempt in range(3):
            try:
                job['attempts'] += 1
                if not job.get('blocks'):
                    job['status'] = 'summarizing'
                    self.save(ident, job)
                    job['summary'] = await self.summarize(self.gateway.http, 'summary', job['record']['segments'])
                    job['blocks'] = build_blocks(job['record'], job['summary'])
                    self.save(ident, job)
                if not job.get('documentId'):
                    # Generic title avoids exposing transcript-derived text before ACL verification.
                    job['status'], job['createPending'] = 'creating', True
                    job['documentTitle'] = '录音纪要 · ' + datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC') + ' · ' + ident[-6:]
                    self.save(ident, job)
                    self.creating.add(ident)
                    try:
                        job['documentId'] = await self.client.create(job['documentTitle'])
                    except ApiError:
                        job['createPending'] = False
                        self.save(ident, job)
                        raise
                    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
                        raise UncertainCreate('创建结果暂未确认，已阻止重复创建；录音与文字保留') from error
                    finally:
                        self.creating.discard(ident)
                    job['createPending'] = False
                    self.save(ident, job)
                doc = job['documentId']
                job['status'] = 'securing'
                self.save(ident, job)
                await self.client.secure(doc, self.config['ownerUserId'])
                existing = await self.client.children(doc)
                expected = [block_text(block) for block in job['blocks']]
                actual = [block_text(block) for block in existing]
                if actual != expected[:len(actual)] or len(actual) > len(expected):
                    raise ContentConflict('飞书文档内容已发生变化，已停止写入；没有覆盖现有内容')
                job['status'] = 'writing'
                self.save(ident, job)
                offset = len(actual)
                while offset < len(expected):
                    token = job['batchTokens'].setdefault(str(offset), str(uuid.uuid4()))
                    self.save(ident, job)
                    await self.client.append(doc, job['blocks'][offset:offset + 30], token)
                    offset += len(job['blocks'][offset:offset + 30])
                    job['writtenBlocks'] = offset
                    self.save(ident, job)
                job['status'] = 'verifying'
                self.save(ident, job)
                if [block_text(block) for block in await self.client.children(doc)] != expected:
                    raise ContentConflict('文档回读与已保存内容不一致，已停止并保留现场')
                job.update(status='ready', url=self.config['docBaseUrl'] + '/docx/' + doc,
                           verifiedAt=datetime.now(timezone.utc).isoformat())
                job.pop('error', None)
                self.save(ident, job)
                return
            except asyncio.CancelledError:
                raise
            except UncertainCreate as error:
                job.update(status='uncertain', error=str(error))
                self.save(ident, job)
                return
            except ContentConflict as error:
                job.update(status='conflict', error=str(error))
                self.save(ident, job)
                return
            except Exception as error:
                transient = isinstance(error, (aiohttp.ClientError, asyncio.TimeoutError)) or (
                    isinstance(error, ApiError) and error.status == 429)
                job.update(status='retrying' if transient and attempt < 2 else 'failed',
                           error=str(error)[:240] if isinstance(error, (ApiError, RuntimeError)) else '文档处理暂时失败，录音与文字保留，可重试')
                self.save(ident, job)
                if job['status'] == 'failed':
                    return
                await asyncio.sleep(2 ** attempt * 3)

    def in_flight(self):
        """Tasks inside a create request: worth letting finish during a stop,
        since an interrupted create is quarantined rather than repeated."""
        return [self.tasks[ident] for ident in list(self.creating) if ident in self.tasks]

    def cancel_all(self):
        tasks = [task for task in self.tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        return tasks

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
