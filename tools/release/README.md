# Release tooling (reference copy)

These are the scripts that staged, reviewed, deployed and verified Clint v45
(`/opt/clint-slack/releases/f169b8f0e114c0df`, 30 Sep 2026), copied verbatim on
2026-10-08 from `Documents\ChatGPT\Clint\evidence\mcp-usable-20260930\`. They are the
current release path, kept here so the repo describes how it ships. They are not yet
parametrised: each release so far copied this set into a new evidence folder and edited
the constants.

| Script | Role | Hard-coded for v45 |
|---|---|---|
| `setup_candidate.py` | copy the installed base tree into `base-vNN/` and `candidate/`, checked against the previous manifest | base id, previous evidence folder |
| `prepare.py` | bump readiness string and client version in the candidate; adjust the control scripts | `v44` to `v45` swaps, job name |
| `stage.py` | upload `candidate/` to the EVO job area, link shared `node_modules`, run `npm run verify`, write `manifest.json` and `verify.json` | `REMOTE`, `SHARED` |
| `make_approval.py` | after independent review, pin the reviewed control files into `approval.json` | file list |
| `install_reviewed.py` | upload the pinned control files to a root-owned control dir and run `deploy.py` under `systemd-run` | `CONTROL`, unit name |
| `deploy.py` | on EVO as root: verify approval, manifest, base hashes and runtime hashes; copy base, overlay candidate, stop Flash and Slack, switch `current`, wait for readiness, roll back on failure | `BASE`, readiness strings `v44`/`v45`, link name |
| `verify_installed.py` | read-only checks of the installed release and the running process environment | expected env values |
| `test_deploy.py` | POSIX unit test of `deploy.py` with systemd mocked | — |

## From a git ref instead of a candidate folder

Since 2026-10-08 every installed release is a tagged commit (`clint-vNN`) on
`main` of `github.com/jamescockburn47/clint`, byte-equal to the release directory.
The candidate for the next release is therefore `git archive <ref>` minus
`node_modules`, `data/`, `.git`, `__pycache__` and the non-shippable suffixes that
`stage_slack_release.py` never shipped (tsx, svg, ps1, Dockerfile and similar).
Parametrising this set (`--ref`, `--job`, base read from `current`, readiness string
read from `src/slack/model.js`) is the next change to make here; it has not been done.

Ledger of release id, version, tag and commit: `/opt/clint-slack/RELEASES.json` on EVO.
