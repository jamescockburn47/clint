"""Copy the installed v44 tree to base-v44/ and candidate/, after checking it byte for byte against the v44 manifest."""
from pathlib import Path
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parent
V44 = ROOT.parent / 'guard-20260930'
manifest = json.loads((V44 / 'manifest.json').read_text())
installed = json.loads((V44 / 'success.json').read_text())
if installed.get('release') != '/opt/clint-slack/releases/c5517d4d8326044d' or \
        hashlib.sha256((V44 / 'manifest.json').read_bytes()).hexdigest()[:16] != 'c5517d4d8326044d':
    raise RuntimeError('v44 manifest is not the installed release')
src = V44 / 'candidate'
for rel, digest in manifest.items():
    if hashlib.sha256((src / rel).read_bytes()).hexdigest() != digest:
        raise RuntimeError(f'v44 candidate differs from manifest: {rel}')
for name in ('base-v44', 'candidate'):
    if (ROOT / name).exists():
        raise RuntimeError(f'{name} exists already')
    for rel in manifest:
        (ROOT / name / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / rel, ROOT / name / rel)
shutil.copyfile(V44 / 'manifest.json', ROOT / 'base-hashes.json')
print('copied', len(manifest), 'files from v44 c5517d4d8326044d')
