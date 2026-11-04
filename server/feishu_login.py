"""Single-owner Feishu sign-in. Codes and provider tokens never leave the server.

The public page obtains an app-bound code through Feishu's native JSAPI. The
server exchanges it once, verifies the current user against an explicit Open ID,
and issues the same private session used by the recording APIs. No offline
access, token persistence, or additional user-data scope is requested.
"""
import asyncio
import hashlib
import hmac
import json
import re
import secrets
import time
from pathlib import Path

import aiohttp
from aiohttp import web

TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token'
USER_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info'
STATE_TTL = 300
PENDING_LIMIT = 512  # all open sign-in pages; the oldest is evicted, never refused
PENDING_PER_CLIENT = 16  # one client can only displace its own older pages
COOKIE = 'minutes_login'
OPEN_ID = re.compile(r'^ou_[A-Za-z0-9_-]{16,100}$')
RANDOM_VALUE = re.compile(r'^[A-Za-z0-9_-]{43}$')

PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>录音豆</title>
<style>body{font:16px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1f2329;background:#fff;margin:0;display:grid;min-height:80vh;place-items:center}main{text-align:center;padding:28px;max-width:360px}h1{font-size:22px}p{line-height:1.6;color:#646a73}button{font:inherit;border:0;border-radius:8px;background:#214e40;color:white;padding:12px 24px}[hidden]{display:none!important}</style>
<main><h1>录音豆</h1><p id="login-status" role="status">正在通过飞书登录…</p>
<button id="login-retry" hidden>重新打开</button></main>
<script id="login-config" type="application/json">__CONFIG__</script>
<script src="__SCRIPT__"></script></html>'''


class FeishuLogin:
    def __init__(self, gateway, config_file, app_id):
        self.gateway = gateway
        path = Path(config_file)
        if path.stat().st_mode & 0o077:
            raise RuntimeError('Identity configuration must be mode 0600')
        config = json.loads(path.read_text())
        if (not isinstance(config, dict) or config.get('appId') != app_id or
                not isinstance(config.get('ownerOpenId'), str) or
                not OPEN_ID.fullmatch(config['ownerOpenId'])):
            raise ValueError('Invalid single-owner identity configuration')
        self.app_id, self.owner = app_id, config['ownerOpenId']
        self.pending = {}

    def page(self, request, destination):
        now = time.monotonic()
        self.pending = {key: value for key, value in self.pending.items() if value[1] > now}
        client = self.gateway.client_key(request)
        mine = [key for key, value in self.pending.items() if len(value) > 2 and value[2] == client]
        for key in mine[:max(0, len(mine) - PENDING_PER_CLIENT + 1)]:
            del self.pending[key]
        while len(self.pending) >= PENDING_LIMIT:
            del self.pending[next(iter(self.pending))]  # insertion order: the oldest page
        nonce, state = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.pending[hashlib.sha256(nonce.encode()).hexdigest()] = (state, now + STATE_TTL, client)
        config = json.dumps({'appId': self.app_id, 'base': self.gateway.base_path,
                             'state': state, 'destination': destination}, ensure_ascii=False).replace('<', '\\u003c')
        response = web.Response(text=PAGE.replace('__CONFIG__', config).replace(
            '__SCRIPT__', self.gateway.base_path + '/auth/feishu-login.js'), content_type='text/html')
        response.set_cookie(COOKIE, nonce, httponly=True, secure=self.gateway.origin.startswith('https:'),
                            samesite='Strict', max_age=STATE_TTL, path=self.gateway.base_path + '/')
        response.headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                                 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
                                 'Content-Security-Policy': "frame-ancestors 'none'"})
        return response

    async def exchange(self, code):
        timeout = aiohttp.ClientTimeout(total=15)
        # requestAccess is an in-client flow: no redirect_uri or PKCE challenge
        # was sent. Client authentication uses the existing server-only secret.
        async with self.gateway.http.post(TOKEN_URL, data={
                'grant_type': 'authorization_code', 'client_id': self.app_id,
                'client_secret': self.gateway.app_secret(), 'code': code},
                timeout=timeout, allow_redirects=False) as response:
            value = await response.json()
            if response.status != 200 or not isinstance(value, dict) or value.get('code') != 0:
                number = value.get('code') if isinstance(value, dict) else None
                print('Feishu token rejected: status=%s code=%s' % (
                    response.status, number if type(number) is int else 'unknown'), flush=True)
                raise web.HTTPUnauthorized(text='飞书登录凭证已失效，请重新打开应用')
        token = value.get('access_token')
        if not isinstance(token, str) or not token or len(token) > 16384:
            raise web.HTTPBadGateway(text='飞书登录暂不可用，请稍后重试')
        async with self.gateway.http.get(USER_URL, headers={'Authorization': 'Bearer ' + token},
                                          timeout=timeout, allow_redirects=False) as response:
            value = await response.json()
            if response.status != 200 or not isinstance(value, dict) or value.get('code') != 0:
                number = value.get('code') if isinstance(value, dict) else None
                print('Feishu identity rejected: status=%s code=%s' % (
                    response.status, number if type(number) is int else 'unknown'), flush=True)
                raise web.HTTPUnauthorized(text='飞书身份验证失败，请重新打开应用')
        info = value.get('data')
        ident = info.get('open_id') if isinstance(info, dict) else None
        if not isinstance(ident, str) or not OPEN_ID.fullmatch(ident) or not hmac.compare_digest(ident, self.owner):
            raise web.HTTPForbidden(text='此应用仅供本人使用，请切换到已授权的飞书账号')

    async def login(self, request):
        self.gateway.check_origin(request)
        client = self.gateway.limit_login(request)
        body = await request.json()
        nonce = request.cookies.get(COOKIE, '')
        state = body.get('state') if isinstance(body, dict) else None
        code = body.get('code') if isinstance(body, dict) else None
        if (not RANDOM_VALUE.fullmatch(nonce) or not isinstance(state, str) or
                not RANDOM_VALUE.fullmatch(state) or not isinstance(code, str) or
                not code or len(code) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in code)):
            raise web.HTTPBadRequest(text='登录请求无效，请重新打开应用')
        # Malformed requests above are refused without counting; every attempt
        # that passed them and still fails counts against this client only.
        key = hashlib.sha256(nonce.encode()).hexdigest()
        expected = self.pending.get(key)
        if not expected or expected[1] <= time.monotonic() or not hmac.compare_digest(state, expected[0]):
            self.gateway.record_login_failure(client)
            raise web.HTTPUnauthorized(text='登录页面已过期，请重新打开应用')
        # Consume before the first await, so parallel requests cannot replay it.
        self.pending.pop(key)
        try:
            await self.exchange(code)
        except (web.HTTPUnauthorized, web.HTTPForbidden):
            self.gateway.record_login_failure(client)
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, TypeError):
            raise web.HTTPBadGateway(text='飞书连接暂不可用，请重新打开应用') from None
        response = self.gateway.new_session()
        response.del_cookie(COOKIE, path=self.gateway.base_path + '/')
        print('Feishu sign-in verified for configured owner', flush=True)
        return response
