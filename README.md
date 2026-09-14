# Clint

Personal assistant and technical/research agent, running on the EVO X2. WhatsApp,
authenticated dashboard chat, tools and the existing Spire/Steads integrations share
the same application. Nightly learning runs independently of WhatsApp.

The September 2026 overhaul is implemented and staged; production installation and
WhatsApp re-pairing are pending. See [findings and evidence](docs/clint-overhaul-2026-09-13.md)
and the [canonical release runbook](docs/release-runbook.md). Older design documents
describe experiments and ambitions, not verified current capabilities.

## Learning that can be inspected

- Extraction selects exact human messages, retaining sender, timestamp, conversation,
  source line and SHA-256. Attribution does not establish truth.
- Private/unknown-scope statements stay in the local archive. Shared memory accepts
  only group-scoped statements; full conversation-scoped retrieval is not implemented.
- Dreams contain sourced recollections and explicitly unverified hypotheses, including
  conflicts and questions. They cannot change facts, identity or permissions.
- One worker records failures, retries unsuccessful reviews and preserves attempts.
  Missing replay or model output cannot certify an improvement.
- Automatic policy v1 accepts owner DMs `/report-style compact` or `/report-style spaced`.
  It changes report spacing, retains a backup and records the request. Source code,
  prompts, tools and permissions remain review-required.
- `improve:code` generates one evidence-linked source proposal and tests baseline and
  candidate snapshots in a constrained container. Passing tests do not authorize deployment.

## Development

Use Node 22.20.0 (Linux staging also verified on 22.22.2), npm and the committed lockfile:

```sh
npm ci --ignore-scripts
npm run verify
```

`verify` runs TypeScript, the source-size gate and the recursive test suite. `npm test`
is the historical subset and is insufficient for release. Keep runtime data, auth state,
`.env` and credentials out of source bundles and fixtures.

Configuration is validated in `src/config.js`. Provide a private `.env` and run:

```sh
node --env-file=.env --import tsx src/index.js
node --env-file=.env --import tsx src/overnight/learning-cli.ts
```

The checked EVO gateway is `http://127.0.0.1:11435`, model ID `qwen3.8-27b`.
Set `EVO_LLM_URL`, `EVO_CHAT_MODEL` and the display label explicitly; historical port
8080 points at a failed model service. A configured MiniMax key retains the existing
cloud preference; omit cloud keys in a local-only environment. Classifier and planner
endpoints are separate configuration and have not been restored by this release.

Set a nonempty `DASHBOARD_TOKEN`; authenticated routes fail closed without one.
`WHATSAPP_ENABLED=false` permits dashboard operation without pairing. Probe the configured
HTTP port before startup. `/health` reports channel state, including `needs_pairing`;
it does not certify every integration. `/api/learning/YYYY-MM-DD` returns worker status
and the latest review to an authenticated owner.

## Operation

The new timer starts at 02:30 Europe/London. Consolidation, probe/research, policy
adaptation, review and report execute sequentially. `OVERNIGHT_IN_PROCESS=false` prevents
duplicate legacy scheduling. Research uses at most three configured public topics,
never private transcript-derived queries. Keep the old dream/evolution timers disabled.

A hard-killed worker can leave `data/overnight/learning-worker.lock`: check the service
and recorded PID before moving an orphan lock aside. Never remove a live lock.

For a source proposal, start from a clean, committed Linux checkout with Docker and
the pinned sandbox image available:

```sh
npm run improve:code -- YYYY-MM-DD observed-failure-event-id src/allowed-module.js
```

Run local-model generation through the EVO `evo-job` control plane. The container limits
host access and tests actual source snapshots; it is not proof against an adversarial
test process. Candidate-specific acceptance and independent review remain required.
