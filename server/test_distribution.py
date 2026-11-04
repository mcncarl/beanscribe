"""Portable configuration checks without accounts, network calls or recordings."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('distribution_run', ROOT / 'tools/run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.folder = ROOT / 'work/tests/distribution' / uuid.uuid4().hex
        self.folder.mkdir(parents=True)
        self.config = {'appId': 'cli_synthetic123', 'origin': 'https://record.example.org',
                       'basePath': '/minutes', 'port': 8897, 'data': str(self.folder / 'data'),
                       'accessTokenFile': str(self.folder / 'access-token'),
                       'appSecretFile': str(self.folder / 'app-secret'),
                       'stepfunKeyFile': str(self.folder / 'stepfun-key'),
                       'identityConfig': str(self.folder / 'identity.json'), 'documentsConfig': ''}
        self.write('app-secret', 'synthetic-secret')
        self.write('stepfun-key', 'synthetic-provider-key')
        self.write('identity.json', json.dumps({'appId': self.config['appId'], 'ownerOpenId': 'ou_' + 'a' * 32}))

    def write(self, name, value):
        path = self.folder / name
        path.write_text(value)
        path.chmod(0o600)
        return path

    def test_custom_application_is_used_and_secrets_are_not_command_arguments(self):
        command, env = runner.prepare(self.config)
        self.assertEqual(env['FEISHU_APP_ID'], self.config['appId'])
        self.assertEqual(command[command.index('--origin') + 1], self.config['origin'])
        self.assertNotIn('synthetic-secret', ' '.join(command))
        self.assertNotIn('synthetic-provider-key', ' '.join(command))
        self.assertFalse((self.folder / 'access-token').exists())

    def test_missing_permissions_and_cross_app_identity_fail_closed(self):
        identity = self.folder / 'identity.json'
        identity.chmod(0o644)
        with self.assertRaisesRegex(ValueError, '0600'):
            runner.prepare(self.config)
        identity.chmod(0o600)
        self.write('identity.json', json.dumps({'appId': 'cli_another', 'ownerOpenId': 'ou_' + 'a' * 32}))
        with self.assertRaisesRegex(ValueError, 'identity'):
            runner.prepare(self.config)

    def test_examples_and_unsafe_origins_are_rejected(self):
        for value in ['http://record.example.org', 'https://record.example.com',
                      'https://record.example.org/minutes', 'https://user:pass@record.example.org']:
            config = {**self.config, 'origin': value}
            with self.subTest(value=value), self.assertRaises(ValueError):
                runner.prepare(config)
        with self.assertRaises(ValueError):
            runner.prepare({**self.config, 'appId': 'cli_REPLACE_ME'})

    def test_document_user_id_and_optional_doubao(self):
        document = self.write('documents.json', json.dumps({'ownerUserId': 'synthetic_user', 'docBaseUrl': 'https://example.feishu.cn'}))
        token = self.write('volc-token', 'synthetic-volc-token')
        command, env = runner.prepare({**self.config, 'documentsConfig': str(document),
                                      'volcAppId': '123456', 'volcTokenFile': str(token)})
        self.assertIn('--documents-config', command)
        self.assertEqual(env['VOLC_ASR_APP_ID'], '123456')
        self.assertNotIn('synthetic-volc-token', repr(env))

    def test_gateway_uses_environment_and_cli_rejects_missing_app_id(self):
        env = os.environ.copy()
        env['FEISHU_APP_ID'] = 'cli_synthetic123'
        result = subprocess.run([sys.executable, '-c', 'import gateway; print(gateway.APP_ID)'],
                                cwd=ROOT / 'server', env=env, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), 'cli_synthetic123')
        env.pop('FEISHU_APP_ID')
        result = subprocess.run([sys.executable, str(ROOT / 'server/gateway.py'),
                                 '--data', str(self.folder / 'unused'), '--access-token-file', str(self.folder / 'unused-token'),
                                 '--app-secret-file', str(self.folder / 'app-secret')],
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('FEISHU_APP_ID', result.stderr)
        self.assertFalse((self.folder / 'unused').exists())
