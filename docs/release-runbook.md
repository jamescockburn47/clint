# Canonical Clint release and recovery

This is the only supported deployment path for the September overhaul. The historical
pull/stash/model-restart script is retired. Execution requires James's explicit deployment
authorization. Source preparation, read-only preflight and isolated rehearsal do not.

## Reviewed release

- Worktree: `C:/Users/James/Documents/ChatGPT/Clint/agent`.
- Source-only release: sibling `release/`, containing `manifest.json`, `install.py` and
  `files/`. The manifest records every affected live-source hash and proposed replacement
  hash. Credentials, runtime data and dependency directories are excluded.
- EVO verified stage: `/home/james/jobs/clint-overhaul-20260913/release-stage`.
- EVO bundle: `/home/james/jobs/clint-overhaul-20260913/release`.
- Target: `/home/james/clawdbot`; release ID `clint-20260913`.

The installer rejects source drift, symlinks, traversal, modified payloads and runtime
paths. Apply requires a matching approved-release ID and independently staged source;
it invokes `npm run verify` before writing, then checks live hashes again. All original
affected files are backed up before any replacement. It never invokes git, systemctl,
model services, messaging, migrations or credential changes.

## Preflight and backup — after deployment authorization

1. Connect using `evo-tailscale`. Run `~/.local/bin/evo-job status`; inspect RAM, disk,
   live bot/timer status and port ownership. Preserve unrelated workloads.
2. Run the bundle check (read-only):

   ```sh
   python3 /home/james/jobs/clint-overhaul-20260913/release/install.py --target /home/james/clawdbot
   ```

   Any drift requires reconciliation and another review; never refresh the manifest
   merely to silence a failure. Verify the gateway still serves `qwen3.8-27b`.
3. Record which Clint learning/dream/evolution timers are enabled. Stop the bot and
   only its learning writers during the switch. Keep legacy dream/evolution writers
   disabled with the new worker. Do not change llama, embedding, memory, voice or game
   services. Check whether a learning worker is active before touching its lock.
4. With the bot stopped, make a mode-0700 private release backup on the EVO containing
   its `.env`, `auth_state`, `data`, legacy `src/data` identity state, current bot/learning unit files and enabled-state
   inventory. Preserve the current `node_modules` by renaming it into that private backup
   immediately before installing replacement dependencies. Probe disk capacity first.
   These are backups of client/private state: never transfer them to a source bundle.
   Confirm archive listing and extract to a second private temporary directory; compare
   hashes before relying on the backup. Source-only rehearsal does not prove this live
   state backup; it must be verified at this step.

## Install and first use

Use Node 22.20.0 or the verified EVO 22.22.2 and the committed lockfile. Run the installer
with a clean test HOME and without inherited application secrets:

```sh
env -i HOME=/home/james/jobs/clint-overhaul-20260913/release-stage/.test-home PATH=/usr/local/bin:/usr/bin:/bin \
  python3 /home/james/jobs/clint-overhaul-20260913/release/install.py \
  --target /home/james/clawdbot \
  --verify-stage /home/james/jobs/clint-overhaul-20260913/release-stage \
  --apply --approved-release clint-20260913
```

The bot remains stopped. Install dependencies in the target using
`npm ci --ignore-scripts --no-audit --no-fund`. On failure, use recovery below before
restarting anything. Preserve original credentials; update only the agreed `.env` fields:

```dotenv
EVO_LLM_URL=http://127.0.0.1:11435
EVO_CHAT_MODEL=qwen3.8-27b
EVO_MAIN_MODEL_LABEL=qwen3.8-27b via local gateway :11435
OVERNIGHT_IN_PROCESS=false
CONSOLIDATE_MODE=shadow
```

Keep a valid `DASHBOARD_TOKEN`. Existing MiniMax keys preserve cloud-first chat behavior;
local-only operation requires an explicit provider choice and omission of cloud keys.
Do not silently reassign planner/classifier endpoints. First release archives all new
learning locally in shadow mode while real conversation privacy boundaries are assessed.

Install only `evo-system/clawdbot.service`, `clint-learning.service` and
`clint-learning.timer` into systemd, reload units and start the bot. Probe the actual
configured HTTP port: unauthenticated `/api/chat` must reject, authenticated synthetic
chat must return a real response, and `/health` must expose any pairing requirement.
James then re-pairs WhatsApp using the authenticated pairing page. Do not delete or
replace existing auth state automatically. Verify an owner-originated incoming request
and reply before claiming WhatsApp readiness; this owner interaction is a release prerequisite.

Run one supervised learning invocation with private logs remaining on the EVO. Inspect
`/api/learning/YYYY-MM-DD`, the worker/event files, exact source references and report.
An empty/missing log or failed model call must be visible. Confirm no fabricated facts
or private statements reached global memory. Enable the new 02:30 London timer only
after that run is acceptable. Source schemas are additive; no database migration or
legacy-memory deletion is part of this release.

## Recovery

Keep the bot/new learning writer stopped. The source backup is
`/home/james/clawdbot/.clint-release-backups/clint-20260913`.

```sh
python3 /home/james/jobs/clint-overhaul-20260913/release/install.py \
  --target /home/james/clawdbot --rollback --approved-release clint-20260913
```

Rollback validates every original-source backup and refuses unrelated post-release
source changes before restoring anything. It restores original files and removes only
new release files; runtime data is untouched. Restore the preserved dependency directory,
`.env` and unit snapshots; disable the new timer and restore the recorded old timer state.
Retain new learning artifacts for investigation. Restore runtime data only if its
integrity is actually affected, from the separately verified private backup. There is
no automatic database rollback because this release performs no migration.

Reload systemd, start the previous bot and check health/logs. The old deployment was
already degraded, so rollback means restoring the previous source/configuration, not
promising a working WhatsApp or missing model service. Record any surviving failure.

## Interrupted learning

A killed worker can leave `data/overnight/learning-worker.lock`. Confirm the service is
inactive and its recorded PID is not a live worker before moving it to an incident
archive and retrying. A malformed status marker also requires inspection; preserve the
failed file. Never automatically delete a lock or overwrite private evidence to get green status.
