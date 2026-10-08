"""Stage and verify the usable-MCP candidate on the EVO job area; no service or production mutation."""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'candidate'
REMOTE = '/home/james/jobs/mcp-usable-20260930'
SHARED = '/home/james/jobs/clint-presentation-5796534095f63ae3/app'
SSH = ['ssh', '-o', 'BatchMode=yes', 'evo-tailscale']
EXCLUDED = {'node_modules', 'data', '.git', '__pycache__'}


def source_files(directory):
    for path in sorted(directory.iterdir()):
        if path.name in EXCLUDED:
            continue
        if path.is_symlink():
            raise RuntimeError('Unexpected source symlink: ' + path.name)
        if path.is_dir():
            yield from source_files(path)
        elif path.is_file():
            yield path


manifest = {path.relative_to(APP).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in source_files(APP)}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2))
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
    for name in manifest:
        archive.add(APP / name, arcname=name, recursive=False)
subprocess.run(SSH + [f'rm -rf {REMOTE}/app && mkdir -p {REMOTE}/app && tar -xzf - -C {REMOTE}/app'],
               input=buffer.getvalue(), check=True)
script = f'''set -eu
cd {REMOTE}/app
ln -s {SHARED}/node_modules node_modules
ln -s {SHARED}/data data
mkdir -p ../test-home
rm -f ../verify.exit
set +e
env -i HOME={REMOTE}/test-home PATH=/usr/bin:/bin LOG_LEVEL=warn timeout 600 npm run verify > ../verify.log 2>&1
echo $? > ../verify.exit
'''
subprocess.run(SSH + ['bash -s'], input=script.encode(), timeout=660, check=True)


def fetch(name):
    # The copy has been seen to stall after a finished run, so it is bounded and tried again. The run itself is not repeated.
    for attempt in range(3):
        try:
            return subprocess.run(SSH + [f'cat {REMOTE}/{name}'], capture_output=True, timeout=90, check=True).stdout
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            if attempt == 2:
                raise


exit_code = int(fetch('verify.exit').decode().strip())
log = fetch('verify.log')
(ROOT / 'verify.log').write_bytes(log)
(ROOT / 'verify.json').write_text(json.dumps({
    'exit': exit_code,
    'manifestSha256': hashlib.sha256((ROOT / 'manifest.json').read_bytes()).hexdigest(),
    'logSha256': hashlib.sha256(log).hexdigest()}))
print(log.decode(errors='replace')[-1600:])
raise SystemExit(exit_code)
