"""Save one secret with hidden input and mode 0600; never overwrite a file."""
import argparse
import getpass
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('path', type=Path)
args = parser.parse_args()
value = getpass.getpass('Secret value (hidden): ').strip()
if not value or '\n' in value or '\r' in value:
    parser.error('Enter one nonempty line')
args.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
fd = os.open(args.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(value + '\n')
print('Saved with mode 0600. The value was not printed.')
