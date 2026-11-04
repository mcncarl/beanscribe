import asyncio
import json
import re
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import feishu_login
from gateway import APP_ID, Gateway, write_json
from feishu_login import FeishuLogin, COOKIE

WORK = Path(__file__).resolve().parents[1] / 'work' / 'tests' / 'test_feishu_login'
OWNER = 'ou_' + 'a' * 32


class FeishuLoginTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = WORK / uuid.uuid4().hex
        self.config = self.folder / 'identity.json'
        write_json(self.config, {'appId': APP_ID, 'ownerOpenId': OWNER})
        secret = self.folder / 'app-secret'
        secret.write_text('test-server-secret')
        secret.chmod(0o600)
        self.gateway = Gateway(self.folder / 'recordings', self.folder / 'access-token',
            'http://127.0.0.1:1', app_secret_file=secret, base_path='/minutes', identity_config=self.config)
        self.client = TestClient(TestServer(self.gateway.application()))
        await self.client.start_server()
        self.gateway.origin = str(self.client.make_url('/')).rstrip('/')
        self.calls = []
        self.provider_owner = OWNER
        self.provider_status = 200
        self.pause = None
        self.code_received = asyncio.Event()

        async def token(request):
            self.calls.append(('token', dict(await request.post())))
            self.code_received.set()
            if self.pause:
                await self.pause.wait()
            return web.json_response({'code': 0, 'access_token': 'provider-secret-token',
                'refresh_token': 'must-not-be-persisted'}, status=self.provider_status)

        async def info(request):
            self.calls.append(('info', request.headers.get('Authorization')))
            return web.json_response({'code': 0, 'data': {'open_id': self.provider_owner,
                'name': 'Ignored display name', 'email': 'private@example.test'}})

        provider = web.Application()
        provider.router.add_post('/token', token)
        provider.router.add_get('/info', info)
        self.provider = TestServer(provider)
        await self.provider.start_server()
        self.patches = [patch('feishu_login.TOKEN_URL', str(self.provider.make_url('/token'))),
                        patch('feishu_login.USER_URL', str(self.provider.make_url('/info')))]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        await self.client.close()
        await self.provider.close()
        for item in self.patches:
            item.stop()

    async def page(self, suffix=''):
        response = await self.client.get('/minutes/login' + suffix)
        text = await response.text()
        config = json.loads(re.search(r'type="application/json">(.*?)</script>', text).group(1))
        return response, text, config

    async def login(self, config, **extra):
        return await self.client.post('/minutes/api/feishu-session',
            json={'code': 'fresh-native-code', 'state': config['state'], **extra},
            headers={'Origin': self.gateway.origin})

    async def test_owner_enters_without_password_and_tokens_stay_on_server(self):
        page, text, config = await self.page('?recording=rec-1')
        self.assertNotIn('type="password"', text)
        self.assertNotIn(self.gateway.token, text)
        self.assertNotIn(OWNER, text)
        self.assertEqual(config['destination'], '/minutes/preview.html?recording=rec-1')
        self.assertEqual(page.headers['Cache-Control'], 'no-store')
        self.assertEqual(page.cookies[COOKIE]['httponly'], True)
        self.assertEqual(page.cookies[COOKIE]['samesite'], 'Strict')
        response = await self.login(config)
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {'ok': True})
        self.assertEqual(self.calls, [('token', {'grant_type': 'authorization_code',
            'client_id': APP_ID, 'client_secret': 'test-server-secret', 'code': 'fresh-native-code'}),
            ('info', 'Bearer provider-secret-token')])
        self.assertEqual((await self.client.get('/minutes/api/recordings')).status, 200)
        self.assertEqual((await self.client.get('/minutes/preview.html')).status, 200)
        self.assertNotIn('provider-secret-token', repr(self.gateway.sessions))
        response = await self.client.get('/minutes/login?recording=rec-1', allow_redirects=False)
        self.assertEqual(response.headers['Location'], '/minutes/preview.html?recording=rec-1')

    async def test_anonymous_api_audio_signing_and_websocket_remain_private(self):
        for path in ['/api/recordings', '/api/audio/rec-1', '/api/stream']:
            self.assertEqual((await self.client.get('/minutes' + path)).status, 401)
        response = await self.client.post('/minutes/api/jsapi-config', json={'url': 'anything'},
                                         headers={'Origin': self.gateway.origin})
        self.assertEqual(response.status, 401)
        self.assertEqual((await self.client.get('/minutes/auth/feishu-login.js')).status, 200)
        self.assertEqual((await self.client.get('/minutes/server/feishu_login.py', allow_redirects=False)).status, 302)

    async def test_wrong_owner_cannot_override_the_identity_check_in_post_body(self):
        _, _, config = await self.page()
        self.provider_owner = 'ou_' + 'b' * 32
        response = await self.login(config, open_id=OWNER, ownerOpenId=OWNER, name='测试用户')
        self.assertEqual(response.status, 403)
        self.assertFalse(self.gateway.sessions)
        self.assertEqual((await self.client.get('/minutes/api/recordings')).status, 401)

    async def test_missing_or_malformed_provider_identity_fails_closed(self):
        for ident in [None, '', OWNER + '恶意', 'ou_wrong']:
            _, _, config = await self.page()
            self.provider_owner = ident
            self.assertEqual((await self.login(config)).status, 403)
        self.assertFalse(self.gateway.sessions)

    async def test_wrong_state_and_cross_origin_do_not_exchange_codes(self):
        _, _, config = await self.page()
        self.assertEqual((await self.login(config, state='x' * 43)).status, 401)
        response = await self.client.post('/minutes/api/feishu-session',
            json={'code': 'native-code', 'state': config['state']}, headers={'Origin': 'https://evil.test'})
        self.assertEqual(response.status, 403)
        self.assertFalse(self.calls)

    async def test_challenge_is_bound_to_http_only_cookie(self):
        _, _, config = await self.page()
        other = TestClient(self.client.server)
        await other.start_server()
        try:
            response = await other.post('/minutes/api/feishu-session',
                json={'code': 'native-code', 'state': config['state']}, headers={'Origin': self.gateway.origin})
            self.assertEqual(response.status, 400)
            self.assertFalse(self.calls)
        finally:
            # Both clients use the same TestServer; close only the second session.
            await other.session.close()

    async def test_expired_challenge_fails_before_provider_access(self):
        _, _, config = await self.page()
        self.gateway.feishu_login.pending = {k: (v[0], time.monotonic() - 1)
                                             for k, v in self.gateway.feishu_login.pending.items()}
        self.assertEqual((await self.login(config)).status, 401)
        self.assertFalse(self.calls)

    async def test_parallel_code_replay_is_exchanged_only_once(self):
        _, _, config = await self.page()
        self.pause = asyncio.Event()
        first = asyncio.create_task(self.login(config))
        await asyncio.wait_for(self.code_received.wait(), 2)
        second = await self.login(config)
        self.assertEqual(second.status, 401)
        self.pause.set()
        self.assertEqual((await first).status, 200)
        self.assertEqual(len([x for x in self.calls if x[0] == 'token']), 1)

    async def test_upstream_errors_never_issue_session_or_reflect_secret_body(self):
        _, _, config = await self.page()
        self.provider_status = 500
        response = await self.login(config)
        self.assertEqual(response.status, 401)
        self.assertNotIn('provider-secret-token', await response.text())
        self.assertFalse(self.gateway.sessions)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual((await self.login(config)).status, 401)

    async def test_new_open_after_session_loss_uses_sso_again(self):
        _, _, config = await self.page()
        self.assertEqual((await self.login(config)).status, 200)
        self.gateway.sessions.clear()  # represents a service restart/expiry
        response = await self.client.get('/minutes/preview.html?recording=existing', allow_redirects=False)
        self.assertEqual(response.headers['Location'], '/minutes/login?recording=existing')
        _, text, config = await self.page('?recording=existing&next=https://evil.test')
        self.assertNotIn('evil.test', text)
        self.assertNotIn('password', text)
        self.assertEqual((await self.login(config)).status, 200)

    async def test_a_flood_of_sign_in_pages_cannot_displace_the_owner(self):
        _, _, owner = await self.page()
        flood = TestClient(self.client.server)
        await flood.start_server()
        try:
            for _ in range(600):   # far past the global cap, from one other client
                response = await flood.get('/minutes/login', headers={'CF-Connecting-IP': '203.0.113.9'})
                self.assertEqual(response.status, 200)   # evicts, never refuses
        finally:
            await flood.session.close()
        mine = [v for v in self.gateway.feishu_login.pending.values() if v[2] == '203.0.113.9']
        self.assertEqual(len(mine), feishu_login.PENDING_PER_CLIENT)
        self.assertEqual((await self.login(owner)).status, 200)

    async def test_global_cap_evicts_the_oldest_page(self):
        with patch.object(feishu_login, 'PENDING_LIMIT', 3):
            states = [(await self.page())[2]['state'] for _ in range(1)]
            for index in range(3):
                await self.client.get('/minutes/login', headers={'CF-Connecting-IP': '192.0.2.%d' % index})
        self.assertEqual(len(self.gateway.feishu_login.pending), 3)
        self.assertNotIn(states[0], [v[0] for v in self.gateway.feishu_login.pending.values()])

    async def test_only_failed_attempts_from_the_same_client_are_limited(self):
        _, _, config = await self.page()
        stranger = {'Origin': self.gateway.origin, 'CF-Connecting-IP': '203.0.113.9'}
        for _ in range(30):   # malformed: refused before any state check, never counted
            response = await self.client.post('/minutes/api/feishu-session', json={}, headers=stranger)
            self.assertEqual(response.status, 400)
        for _ in range(10):   # well-formed but wrong: counted against that client only
            response = await self.client.post('/minutes/api/feishu-session',
                                              json={'code': 'c', 'state': 'x' * 43}, headers=stranger)
            self.assertEqual(response.status, 401)
        response = await self.client.post('/minutes/api/feishu-session',
                                          json={'code': 'c', 'state': 'x' * 43}, headers=stranger)
        self.assertEqual(response.status, 429)
        self.assertEqual((await self.login(config)).status, 200)
        self.assertFalse([call for call in self.calls if call[0] == 'token' and call[1]['code'] == 'c'])

    async def test_invalid_configuration_fails_closed(self):
        for config in [{'appId': 'other-app', 'ownerOpenId': OWNER}, {'appId': APP_ID, 'ownerOpenId': ''}]:
            write_json(self.config, config)
            with self.assertRaises(ValueError):
                FeishuLogin(self.gateway, self.config, APP_ID)
        write_json(self.config, {'appId': APP_ID, 'ownerOpenId': OWNER})
        self.config.chmod(0o644)
        with self.assertRaises(RuntimeError):
            FeishuLogin(self.gateway, self.config, APP_ID)

    async def test_https_session_has_secure_http_only_scoped_cookie(self):
        self.gateway.origin = 'https://private.example.test'
        response = self.gateway.new_session()
        cookie = response.cookies['minutes_session']
        self.assertTrue(cookie['secure'])
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Strict')
        self.assertEqual(cookie['path'], '/minutes/')


if __name__ == '__main__':
    unittest.main()
