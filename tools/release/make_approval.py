"""Record the approval the installer requires, pinning every control file by hash. Written by the deploying session, which
did not write the reviews; it records their verdicts and the owner's direction."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parent


def sha(name):
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()


recheck = (ROOT / 'RECHECK-N1.md').read_text(encoding='utf-8')
if '**Verdict: PASS' not in recheck[:600]:
    raise RuntimeError('The targeted re-check did not pass')
verification = json.loads((ROOT / 'verify.json').read_text())
if verification['exit'] != 0 or verification['manifestSha256'] != sha('manifest.json') or verification['logSha256'] != sha('verify.log'):
    raise RuntimeError('Verification does not bind the manifest and log as they stand')
manifest = json.loads((ROOT / 'manifest.json').read_text())
for name, digest in manifest.items():
    if hashlib.sha256((ROOT / 'candidate' / name).read_bytes()).hexdigest() != digest:
        raise RuntimeError('Candidate differs from the manifest: ' + name)
names = ['deploy.py', 'install_reviewed.py', 'prepare.py', 'stage.py', 'verify_installed.py', 'test_deploy.py', 'manifest.json',
         'verify.json', 'base-hashes.json', 'runtime-hashes.json', 'deployment-tests.log', 'INDEPENDENT-REVIEW.md',
         'INDEPENDENT-REVIEW-R2.md', 'RECHECK-N1.md', 'OWNER-NOTE-V45.md']
approval = {
    'approved': True,
    'reviewer': 'RECHECK-N1.md (targeted re-check of the N1 fix, as INDEPENDENT-REVIEW-R2.md condition 1 allows)',
    'earlierReviews': ['INDEPENDENT-REVIEW.md: CHANGES REQUIRED', 'INDEPENDENT-REVIEW-R2.md: CHANGES REQUIRED (N1 only)'],
    'recordedBy': 'deploying session, which did not write the reviews; recorded verbatim from the reviewers\' final messages',
    'ownerDirection': '30 September 2026: "Continue. Also don\'t make this so overly restrictive that I or another authorised person '
                      'can\'t ask details from Clint, and make sure that he can usefully install trustworthy MCPs"',
    'openConditions': 'R2 (c)2: standing per-tool approval departs from the 27 Sep per-action rule — stated in OWNER-NOTE-V45.md; '
                      'the owner grants it tool by tool with "mcp allow". R2 (c)4: Instinct user grant — owner note asks him to revoke '
                      'or verify before approving acting tools. R2 (c)3: no live mcp-trust.json existed (checked).',
    'manifestSha256': sha('manifest.json'),
    'tests': 'staged verify as in verify.json; 2 deployment tests',
    'files': {name: sha(name) for name in names},
}
(ROOT / 'approval.json').write_text(json.dumps(approval, indent=2), newline='\n')
print('approval recorded for manifest', approval['manifestSha256'][:16])
