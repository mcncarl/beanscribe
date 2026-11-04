"""Validate private deployment files and start the gateway without secret argv."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def resolved(value):
    if not isinstance(value, str) or not value:
        raise ValueError('Expected a nonempty file path')
    path = Path(value).expanduser()
    return path if path.is_absolute() else ROOT / path


def private_file(value, label):
    path = resolved(value)
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError(label + ' must exist and have mode 0600')
    if not path.read_text().strip():
        raise ValueError(label + ' must not be empty')
    return path


def prepare(config):
    if not isinstance(config, dict):
        raise ValueError('settings must be a JSON object')
    app_id = config.get('appId', '')
    if not re.fullmatch(r'cli_[A-Za-z0-9]+', app_id) or 'REPLACE' in app_id:
        raise ValueError('appId must be your own Feishu application ID')
    origin = config.get('origin', '')
    url = urlsplit(origin)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.path or url.query or url.fragment or url.hostname.endswith(('.example.com', '.invalid'))):
        raise ValueError('origin must be your HTTPS origin without a trailing slash or path')
    base = config.get('basePath', '/minutes')
    if base and not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)+', base):
        raise ValueError('basePath must be empty or a path such as /minutes')
    port = config.get('port', 8897)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('port must be between 1 and 65535')
    secret = private_file(config['appSecretFile'], 'Feishu App Secret')
    stepfun = private_file(config['stepfunKeyFile'], 'StepFun key')
    identity = private_file(config['identityConfig'], 'identity configuration')
    owner = json.loads(identity.read_text())
    if (not isinstance(owner, dict) or owner.get('appId') != app_id or
            not re.fullmatch(r'ou_[A-Za-z0-9_-]{16,100}', owner.get('ownerOpenId', '')) or
            'REPLACE' in owner.get('ownerOpenId', '')):
        raise ValueError('identity must contain this application ID and your own application Open ID')
    token = resolved(config['accessTokenFile'])
    if token.exists():
        private_file(config['accessTokenFile'], 'maintenance access token')
        if len(token.read_text().strip()) < 32:
            raise ValueError('maintenance access token must have at least 32 characters')
    env = {'FEISHU_APP_ID': app_id, 'STEPFUN_CN_API_KEY_FILE': str(stepfun)}
    args = [str(ROOT / 'server/gateway.py'), '--bind', config.get('bind', '127.0.0.1'),
            '--port', str(port), '--origin', origin, '--base-path', base,
            '--data', str(resolved(config['data'])), '--access-token-file', str(token),
            '--app-secret-file', str(secret), '--identity-config', str(identity)]
    if config.get('documentsConfig'):
        documents = private_file(config['documentsConfig'], 'document configuration')
        doc = json.loads(documents.read_text())
        if (not isinstance(doc, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', doc.get('ownerUserId', '')) or
                'REPLACE' in doc.get('ownerUserId', '') or
                not re.fullmatch(r'https://[a-z0-9-]+\.feishu\.cn', doc.get('docBaseUrl', '')) or
                doc.get('docBaseUrl') == 'https://your-team.feishu.cn'):
            raise ValueError('documents must contain your tenant user ID and Feishu document domain')
        args.extend(['--documents-config', str(documents)])
    if config.get('volcAppId') or config.get('volcTokenFile'):
        if not re.fullmatch(r'[A-Za-z0-9_-]+', config.get('volcAppId', '')):
            raise ValueError('volcAppId is required when enabling Doubao')
        token_file = private_file(config['volcTokenFile'], 'Doubao token')
        env.update(VOLC_ASR_APP_ID=config['volcAppId'], VOLC_ASR_TOKEN_FILE=str(token_file))
    return args, env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / 'config/settings.json')
    parser.add_argument('--check', action='store_true', help='validate locally; no API calls or server start')
    args = parser.parse_args()
    try:
        command, env = prepare(json.loads(args.config.read_text()))
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Never print configuration values or exceptions containing private paths.
        message = str(error) if type(error) is ValueError else type(error).__name__
        parser.error(message)
    if args.check:
        print('Configuration is valid. No external API was called.')
        return
    # Explicit file configuration takes precedence over inherited account secrets.
    for key in ('FEISHU_APP_SECRET', 'STEPFUN_CN_API_KEY', 'VOLC_ASR_APP_ID',
                'VOLC_ASR_TOKEN', 'VOLC_ASR_TOKEN_FILE'):
        os.environ.pop(key, None)
    os.environ.update(env)
    os.execv(sys.executable, [sys.executable, *command])


if __name__ == '__main__':
    main()
