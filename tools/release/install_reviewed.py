"""Upload only review-bound control files, then invoke the canonical remote installer."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent
CONTROL = '/var/lib/mcp-usable-20260930'
SSH = ['ssh', '-o', 'BatchMode=yes', 'evo-tailscale']
approval = json.loads((ROOT / 'approval.json').read_text())
if approval.get('approved') is not True:
    raise RuntimeError('Independent approval required')
names = list(approval['files']) + ['approval.json']
for name in names:
    if Path(name).name != name or '/' in name or '\\' in name:
        raise ValueError('Control files must be plain basenames')
    if name != 'approval.json' and hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != approval['files'][name]:
        raise ValueError('Review pin changed: ' + name)
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
    for name in names:
        archive.add(ROOT / name, arcname=name, recursive=False)
subprocess.run(SSH + [f'sudo -n test ! -e {CONTROL} && sudo -n install -d -m 700 {CONTROL} && sudo -n tar -xzf - -C {CONTROL}'],
               input=buffer.getvalue(), check=True, timeout=45)
command = ['sudo', '-n', 'systemd-run', '--unit=mcp-usable-deploy', '--collect', '--wait', '--pipe',
           '--property=RuntimeMaxSec=8100', '/usr/bin/python3', CONTROL + '/deploy.py']
with (ROOT / 'deployment-console.txt').open('x') as log:
    result = subprocess.run(SSH + [' '.join(command)], stdout=log, stderr=subprocess.STDOUT, timeout=8160)
print('Deployment command exit:', result.returncode)
print((ROOT / 'deployment-console.txt').read_text()[-2000:])
for name in ['started.json', 'success.json', 'failure.json', 'rollback.json', 'rollback-failed.json']:
    item = subprocess.run(SSH + ['sudo -n cat ' + CONTROL + '/' + name], capture_output=True, timeout=20)
    if item.returncode == 0:
        (ROOT / name).write_bytes(item.stdout)
raise SystemExit(result.returncode)
