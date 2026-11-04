"""Check tracked distribution files without printing any matched secret values."""
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
IGNORED = {'.git', '.venv', 'node_modules', '__pycache__', 'work', 'secrets', 'data'}
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'provider-key': re.compile(r'\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|AKIA[A-Z0-9]{16})\b'),
    'real-app-id': re.compile(r'\bcli_[a-f0-9]{12,}\b'),
    'real-open-id': re.compile(r'\bou_[A-Za-z0-9]{24,}\b'),
    'personal-home': re.compile(r'/(?:Users|home)/[A-Za-z0-9_.-]+/'),
    'private-feishu-document': re.compile(r'https://[a-z0-9-]+\.feishu\.cn/(?:docx|wiki)/[A-Za-z0-9]{16,}'),
}
BLOCKED_SUFFIXES = {'.wav', '.mp3', '.m4a', '.mp4', '.mov', '.ipa', '.apk', '.har', '.pcap', '.pcapng', '.pem', '.key', '.zip', '.tar', '.gz', '.log', '.jsonl'}
REQUIRED = ['README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY.md', 'AGENTS.md',
            'docs/SETUP.md', 'docs/NAVIGATION.md', 'docs/USAGE.md', 'docs/DEVELOPMENT.md',
            'docs/TROUBLESHOOTING.md', 'docs/VALIDATION.md', 'preview.html',
            'h5/index.html', 'h5/minutes-runtime.js', 'h5/d3200-bundle.js', 'h5/feishu-login.js',
            'server/gateway.py', 'server/stepfun.py', 'server/volc.py', 'server/file_asr.py',
            'server/feishu_docs.py', 'server/feishu_login.py', 'server/opus.py', 'server/requirements.txt',
            'tools/run.py', 'tools/save_secret.py', 'config/settings.example.json',
            'config/identity.example.json', 'config/documents.example.json',
            'deploy/luyindou.service', 'deploy/Caddyfile.example', 'test/fixtures/synthetic-opus.bin']


def files():
    if (ROOT / '.git').exists():
        result = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True)
        return [ROOT / name for name in result.stdout.decode().split('\0') if name]
    return [p for p in ROOT.rglob('*') if p.is_file() and not set(p.relative_to(ROOT).parts) & IGNORED]


def main():
    paths = files()
    names = {str(p.relative_to(ROOT)) for p in paths}
    findings = []

    def fail(path, reason, line=None):
        findings.append({'path': str(path), 'reason': reason, **({'line': line} if line else {})})

    for required in REQUIRED:
        if required not in names:
            fail(required, 'missing required distribution file')
    for path in paths:
        relative = path.relative_to(ROOT)
        if path.is_symlink() or set(relative.parts) & IGNORED or path.suffix in BLOCKED_SUFFIXES:
            fail(relative, 'private/runtime file type must not be tracked')
            continue
        if path.suffix == '.bin':
            if str(relative) != 'test/fixtures/synthetic-opus.bin':
                fail(relative, 'unapproved binary fixture')
            continue
        try:
            source = path.read_text()
        except UnicodeDecodeError:
            fail(relative, 'unreviewed binary content')
            continue
        for label, pattern in PATTERNS.items():
            for match in pattern.finditer(source):
                fail(relative, label, source.count('\n', 0, match.start()) + 1)
        for match in re.finditer(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', source):
            try:
                address = ipaddress.ip_address(match.group())
            except ValueError:
                continue
            if address.is_global:
                fail(relative, 'public IPv4 address requires removal or documented review', source.count('\n', 0, match.start()) + 1)
        if path.suffix == '.md':
            for match in re.finditer(r'\]\(([^)\s]+)\)', source):
                link = match.group(1)
                if re.match(r'[a-zA-Z]+:', link) or link.startswith('#'):
                    continue
                target = (path.parent / link.split('#')[0]).resolve()
                if not target.is_relative_to(ROOT) or not target.exists():
                    fail(relative, 'broken or external local documentation link', source.count('\n', 0, match.start()) + 1)
        if path.suffix in {'.html', '.ttml'}:
            for link in re.findall(r'(?:src|href)=[\'"]([^\'"]+)[\'"]', source):
                if re.match(r'[a-zA-Z]+:', link) or link.startswith(('#', '/', '{{')):
                    continue
                target = path.parent / link.split('?')[0].split('#')[0]
                if not target.exists():
                    fail(relative, 'missing local page asset')
    fixture = ROOT / 'test/fixtures/synthetic-opus.bin'
    metadata = json.loads(fixture.with_suffix('.json').read_text())
    if hashlib.sha256(fixture.read_bytes()).hexdigest() != metadata['sha256']:
        fail(fixture.relative_to(ROOT), 'synthetic fixture hash mismatch')
    for item in json.loads((ROOT / 'vendor/vendor-lock.json').read_text())['vendored_files']:
        path = ROOT / 'vendor' / item['path']
        if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            fail(path.relative_to(ROOT), 'vendor hash mismatch')
    print(json.dumps({'filesChecked': len(paths), 'findingCount': len(findings), 'findings': findings}, ensure_ascii=False, indent=2))
    return bool(findings)


if __name__ == '__main__':
    sys.exit(main())
