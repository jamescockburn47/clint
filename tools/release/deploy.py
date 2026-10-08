"""Reviewed usable-MCP release; exact code/config rollback via maintained controller."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
STAGE = Path('/home/james/jobs/mcp-usable-20260930')
BASE = Path('/opt/clint-slack/releases/c5517d4d8326044d')
CURRENT = BASE.parent.parent / 'current'
LEASE = Path('/var/lib/clint-flash-persistent/active.json')
ENVIRONMENT = Path('/etc/clint-slack/runtime.env')
RUNTIME = Path('/usr/local/lib/clint-flash')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def save(name, value):
    (ROOT / name).write_text(json.dumps(value, indent=2))


def run(arguments, timeout=30):
    return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def switch(target):
    link = CURRENT.with_name('mcp-usable-next')
    if link.exists() or link.is_symlink():
        raise RuntimeError('Previous release switch unresolved')
    link.symlink_to(target, target_is_directory=True)
    os.replace(link, CURRENT)


def configure(content):
    temporary = ENVIRONMENT.with_name('runtime.env.papers-next')
    if temporary.exists(): raise RuntimeError('Unresolved environment replacement')
    previous = ENVIRONMENT.stat()
    with temporary.open('xb') as file: file.write(content)
    os.chown(temporary, previous.st_uid, previous.st_gid)
    temporary.chmod(previous.st_mode & 0o777)
    os.replace(temporary, ENVIRONMENT)


def ready(target, version):
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        if run(['systemctl', 'show', 'clint-flash', '-p', 'ActiveState', '--value']) in ('inactive', 'failed'):
            raise RuntimeError('Flash activation failed')
        path = Path('/var/lib/clint-flash-persistent/activated.json')
        if path.exists():
            proof = read(path)
            invocation = run(['systemctl', 'show', 'clint-slack', '-p', 'InvocationID', '--value'])
            if proof.get('release') == str(target) and proof.get('invocation') == invocation:
                logs = run(['journalctl', '--no-pager', '-o', 'cat', '_SYSTEMD_INVOCATION_ID=' + invocation])
                if '"status":"ready:' + version + '"' in logs and '"status":"socket_connected"' in logs:
                    run(['systemctl', 'is-active', '--quiet', 'clint-slack'])
                    return proof
        time.sleep(2)
    raise TimeoutError('Release readiness deadline')


def recovery_environment(content):
    return content


def main():
    if os.geteuid() != 0 or CURRENT.resolve() != BASE:
        raise RuntimeError('Unexpected user or live baseline')
    if ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o077:
        raise RuntimeError('Deployment directory must be root owned and private')
    approval = read(ROOT / 'approval.json')
    if approval.get('approved') is not True:
        raise RuntimeError('Independent review has not approved deployment')
    for name, digest in approval['files'].items():
        if sha(ROOT / name) != digest:
            raise RuntimeError('Reviewed deployment file changed: ' + name)
    manifest = read(ROOT / 'manifest.json')
    verification = read(ROOT / 'verify.json')
    if verification['exit'] != 0 or verification['manifestSha256'] != sha(ROOT / 'manifest.json'):
        raise RuntimeError('Verification does not bind candidate')
    if verification['logSha256'] != sha(STAGE / 'verify.log'):
        raise RuntimeError('Verification log changed')
    for name, digest in manifest.items():
        if sha(STAGE / 'app' / name) != digest:
            raise RuntimeError('Candidate changed: ' + name)
    for name, digest in read(ROOT / 'base-hashes.json').items():
        if sha(BASE / name) != digest:
            raise RuntimeError('Installed base changed: ' + name)
    target = BASE.parent / sha(ROOT / 'manifest.json')[:16]
    if target.exists() or (ROOT / 'started.json').exists():
        raise RuntimeError('Deployment already started')
    runtime = {name: sha(RUNTIME / name) for name in
               ['controller.py', 'lifecycle.py', 'thermal_profile.py', 'fan_governor.py', 'cleanup.py']}
    if runtime != read(ROOT / 'runtime-hashes.json'):
        raise RuntimeError('Reviewed runtime changed')
    previous_environment = ENVIRONMENT.read_bytes()
    environment = sha(ENVIRONMENT)
    next_environment = previous_environment
    with (ROOT / 'runtime.env.previous').open('xb') as backup: backup.write(previous_environment)
    (ROOT / 'runtime.env.previous').chmod(0o600)
    shutil.copytree(BASE, target, symlinks=True)
    for name in manifest:
        dest = target / name
        if dest.is_file() and sha(dest) == manifest[name]:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(STAGE / 'app' / name, dest)
        os.chown(dest, 0, 0); dest.chmod(0o644)
    for name, digest in manifest.items():
        if sha(target / name) != digest:
            raise RuntimeError('Installed candidate changed: ' + name)
    save('started.json', {'base': str(BASE), 'target': str(target), 'runtime': runtime, 'environment': environment})
    try:
        run(['systemctl', 'stop', 'clint-flash'], 960)
        if LEASE.exists(): raise RuntimeError('Unresolved Flash lease')
        run(['systemctl', 'stop', 'clint-slack'], 150)
        switch(target)
        run(['systemctl', 'reset-failed', 'clint-flash'])
        run(['systemctl', 'start', 'clint-flash'], 240)
        proof = ready(target, 'clint-shared-core-v45')
        if ENVIRONMENT.read_bytes() != next_environment:
            raise RuntimeError('Environment differs from reviewed configuration')
        for name, digest in runtime.items():
            if sha(RUNTIME / name) != digest:
                raise RuntimeError('Runtime changed: ' + name)
        save('success.json', {'ready': True, 'release': str(target), 'proof': proof})
    except Exception as error:
        save('failure.json', {'error': type(error).__name__, 'message': str(error)[:180]})
        try:
            run(['systemctl', 'stop', 'clint-flash'], 960)
            if LEASE.exists(): raise RuntimeError('Unresolved rollback lease')
            run(['systemctl', 'stop', 'clint-slack'], 150)
            recovery = recovery_environment(previous_environment)
            configure(recovery)
            if CURRENT.resolve() != BASE: switch(BASE)
            run(['systemctl', 'reset-failed', 'clint-flash'])
            run(['systemctl', 'start', 'clint-flash'], 240)
            save('rollback.json', {'restored': True, 'environmentRestored': sha(ENVIRONMENT) == environment,
                                   'publicTemporarilyDisabled': False, 'recoveryEnvironmentMatched': ENVIRONMENT.read_bytes() == recovery,
                                   'proof': ready(BASE, 'clint-shared-core-v44')})
        except Exception as recovery:
            save('rollback-failed.json', {'error': type(recovery).__name__, 'message': str(recovery)[:180]})
            raise
        raise


if __name__ == '__main__':
    with (ROOT / 'deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        main()
