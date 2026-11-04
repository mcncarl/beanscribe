"""Explicit paced replay of an existing Opus fixture through the real gateway.

This creates a billed provider session. It is never a live-device acceptance.
"""
import argparse
import asyncio
import hashlib
import json
import struct
import time
import uuid
from pathlib import Path

import aiohttp


async def run(args):
    origin = args.origin.rstrip('/')
    data = args.source.read_bytes()
    if not data or len(data) % 160:
        raise ValueError('Source must contain whole 160-byte Opus frames')
    ident = 'replay-' + uuid.uuid4().hex
    report = {'recordingId': ident, 'sourceType': 'recorded_file_test', 'sourceSha256': hashlib.sha256(data).hexdigest(),
              'frames': len(data) // 160, 'expectedDurationMs': len(data) // 160 * 20,
              'events': [], 'startedAt': time.time(), 'liveDeviceVerified': False}
    token = args.access_token_file.read_text().strip()
    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as http:
        async with http.post(origin + '/api/session', json={'token': token}, headers={'Origin': origin}) as response:
            if response.status != 200:
                raise RuntimeError('Gateway authentication failed')
        async with http.ws_connect(origin + '/api/stream', headers={'Origin': origin}) as ws:
            await ws.send_json({'type': 'start', 'recordingId': ident, 'language': args.language,
                                'sourceType': 'recorded_file_test'})
            ready = await ws.receive_json(timeout=15)
            if ready.get('type') != 'ready':
                raise RuntimeError('Gateway did not become ready')
            complete = asyncio.Future()
            acknowledgments = set()

            async def receive():
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    event = json.loads(msg.data)
                    if event.get('type') == 'ack':
                        acknowledgments.add(event['sequence'])
                    else:
                        report['events'].append({'elapsed': round(time.time() - report['startedAt'], 3), **event})
                    if event.get('type') in ('complete', 'error'):
                        if not complete.done():
                            complete.set_result(event)
                        break

            receiver = asyncio.create_task(receive())
            try:
                for index in range(report['frames']):
                    if complete.done():
                        break
                    await ws.send_bytes(struct.pack('<I', index) + data[index * 160:(index + 1) * 160])
                    await asyncio.sleep(0.02)
                report['lastSentAt'] = time.time()
                if not complete.done():
                    await ws.send_json({'type': 'stop'})
                event = await asyncio.wait_for(complete, 45)
                report['acknowledgedFrames'] = len(acknowledgments)
                report['result'] = event
                report['status'] = 'passed' if event.get('type') == 'complete' else 'failed'
            finally:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
        if report['status'] == 'passed':
            async with http.get(origin + report['result']['audio']['url']) as response:
                audio = await response.read()
                report['savedAudioHttpStatus'] = response.status
                report['savedAudioSha256'] = hashlib.sha256(audio).hexdigest()
                report['savedAudioBytes'] = len(audio)
            report['textBeforeLastSentAudio'] = any(event['type'] == 'caption' and
                event['elapsed'] < report['lastSentAt'] - report['startedAt'] for event in report['events'])
    report['completedAt'] = time.time()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    args.output.chmod(0o600)
    print(json.dumps({k: report[k] for k in ('recordingId', 'status', 'frames', 'acknowledgedFrames', 'liveDeviceVerified')}, ensure_ascii=False))
    return report['status'] == 'passed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', default='http://127.0.0.1:8897')
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--access-token-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--language', choices=['zh', 'en'], default='zh')
    args = parser.parse_args()
    raise SystemExit(0 if asyncio.run(run(args)) else 1)
