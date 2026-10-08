"""Derive the v45 deployment controls from the v44 rollout's controls, and bump the release version.
Baseline: installed v44 (c5517d4d8326044d); candidate readiness v45; rollback readiness v44. Environment unchanged; lane off."""
from pathlib import Path
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parent
OLD = ROOT.parent / 'guard-20260930'
OLD_BASE = 'f5e04bfdfac063ad'
installed = json.loads((OLD / 'success.json').read_text())
NEW_BASE = hashlib.sha256((OLD / 'manifest.json').read_bytes()).hexdigest()[:16]
if installed.get('ready') is not True or installed.get('release') != '/opt/clint-slack/releases/' + NEW_BASE:
    raise RuntimeError('v44 is not recorded as installed from this manifest')


def swap(code, old, new, count):
    if code.count(old) != count:
        raise RuntimeError(f'anchor count {code.count(old)} (expected {count}): {old[:70]!r}')
    return code.replace(old, new)


EXPECTED = {  # (baseline hash, v44 candidate, v43 rollback, job/control name, unit, link)
    'deploy.py': (1, 1, 1, 1, 0, 1),
    'test_deploy.py': (0, 1, 0, 0, 0, 0),
    'install_reviewed.py': (0, 0, 0, 1, 1, 0),
    'verify_installed.py': (0, 0, 0, 0, 0, 0),
    'stage.py': (0, 0, 0, 1, 0, 0),
}
for name, (base, candidate, rollback, job, unit, link) in EXPECTED.items():
    code = (OLD / name).read_text()
    code = swap(code, OLD_BASE, NEW_BASE, base)
    code = swap(code, 'clint-shared-core-v44', 'clint-shared-core-v45', candidate)
    code = swap(code, 'clint-shared-core-v43', 'clint-shared-core-v44', rollback)
    code = swap(code, 'guard-20260930', 'mcp-usable-20260930', job)
    code = swap(code, 'guard-deploy', 'mcp-usable-deploy', unit)
    code = swap(code, 'guard-next', 'mcp-usable-next', link)
    if name == 'deploy.py':
        code = swap(code, '"""Reviewed injection-guard release;', '"""Reviewed usable-MCP release;', 1)
    if name == 'stage.py':
        code = swap(code, '"""Stage and verify the injection-guard candidate', '"""Stage and verify the usable-MCP candidate', 1)
    for stale in [OLD_BASE, 'clint-shared-core-v43', 'guard-20260930', 'guard-deploy', 'guard-next']:
        if stale in code:
            raise RuntimeError(f'{name} still names {stale}')
    (ROOT / name).write_text(code, newline='\n')
shutil.copyfile(OLD / 'runtime-hashes.json', ROOT / 'runtime-hashes.json')
for rel, old, new in [('candidate/src/slack/model.js', b'clint-shared-core-v44', b'clint-shared-core-v45'),
                      ('candidate/test/slack-mcp-tools.test.js', b"'clint-shared-core-v44'", b"'clint-shared-core-v45'"),
                      ('candidate/test/slack-mcp-tools.test.js', b"release is v44;", b"release is v45;"),
                      ('candidate/src/slack/mcp-tools.js', b"clientVersion: '45'", b"clientVersion: '45'")]:
    p = ROOT / rel
    data = p.read_bytes()
    if data.count(old) != 1:
        raise RuntimeError(f'{rel}: {old!r} found {data.count(old)} times')
    p.write_bytes(data.replace(old, new))
print('controls prepared; baseline', NEW_BASE, '; version v45')
