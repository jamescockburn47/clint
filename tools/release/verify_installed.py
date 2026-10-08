"""Read-only checks of the installed release and the actual running process configuration."""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent
def command(args):
    return subprocess.check_output(args, text=True, timeout=20).strip()
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
manifest = json.loads((ROOT / 'manifest.json').read_text())
release = Path('/opt/clint-slack/current').resolve()
expected = release.parent / sha(ROOT / 'manifest.json')[:16]
pid = int(command(['systemctl', 'show', 'clint-slack', '-p', 'MainPID', '--value']))
if pid <= 0: raise RuntimeError('Slack has no running process')
# Keep credentials in memory only; output contains comparisons, never environment values.
environment = dict(item.split(b'=', 1) for item in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in item)
checks = {
    'expectedRelease': release == expected,
    'runningProcessRelease': Path(f'/proc/{pid}/cwd').resolve() == expected,
    'installedManifest': all(sha(release / name) == digest for name, digest in manifest.items()),
    'slackActive': command(['systemctl', 'is-active', 'clint-slack']) == 'active',
    'flashActive': command(['systemctl', 'is-active', 'clint-flash']) == 'active',
    'papersEnabledInProcess': environment.get(b'SLACK_PAPERS_ENABLED') == b'true',
    'proactiveEnabledInProcess': environment.get(b'SLACK_PROACTIVE_ENABLED') in (None, b'true'),
    'proactivePolicyEnabled': json.loads(environment.get(b'SLACK_CHANNEL_POLICY', b'{}')).get('mode') == 'open',
    'papersStartDateInProcess': environment.get(b'SLACK_PAPERS_FROM') == b'2026-09-20',
    'flashModelInProcess': environment.get(b'SLACK_MODEL_ID') == b'qwen3.8-flash-next',
    'flashEndpointInProcess': environment.get(b'SLACK_MODEL_URL') == b'http://127.0.0.1:11437',
    'laneOffInProcess': b'SLACK_PEER_CHANNEL_ID' not in environment and b'SLACK_PEER_APP_ID' not in environment,
}
with urllib.request.urlopen('http://127.0.0.1:11437/health', timeout=20) as response:
    checks['modelHealthy'] = json.load(response).get('status') == 'ok'
activation = json.loads(Path('/var/lib/clint-flash-persistent/activated.json').read_text())
checks['freshActivation'] = (activation.get('release') == str(expected) and
    activation.get('invocation') == command(['systemctl', 'show', 'clint-slack', '-p', 'InvocationID', '--value']))
proof = {'passed': all(checks.values()), 'release': str(release), 'pid': pid, 'checks': checks,
    'scope': 'Installed files, running configuration and model readiness; tool behaviour in conversation is a separate trial.'}
(ROOT / 'installed-proof.json').write_text(json.dumps(proof, indent=2))
print(json.dumps(proof))
if not proof['passed']: raise RuntimeError('Installed check failed')
