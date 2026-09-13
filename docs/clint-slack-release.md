# Clint shared-core Slack release — 13 September 2026

## Current status

The separate minimal-prompt pilot has been replaced in source. Slack now invokes
`LLMService.getResponse`: Clint's existing prompt, Cortex, category routing,
planner, tools, critique and deterministic outbound filter. No Slack app or service
has been installed yet. Production readiness still requires the actual Slack entry
journey below. Do not use the superseded minimal-file deployment instructions.

James selected `clint-qtj3570.slack.com` (workspace `T0C2CKVEPKJ`) after LQ's app
limit blocked installation. This is distinct from the mistyped `clint-ktj3570`.
The browser still needs a signed-in session for Clint. LQ remains the eventual
preferred workspace.

## Preserved controls and deliberate changes

- Explicit adapter-created identity and audience replace WhatsApp suffix assumptions.
  Slack channels are groups, never implicit owner DMs. Missing identity grants no tools.
- The existing open/project/colleague policies, blocked topics, canary, writing rules
  and group boundaries remain. A Slack channel's policy is explicit configuration;
  it does not modify the live WhatsApp registry. Open mode retains its historical
  full private-context meaning and therefore requires deliberate operator selection.
- Restricted recall admits only records attributed to the current channel or an
  allowed `project:<id>`. Unattributed and other-channel records are excluded before
  prompt assembly. Cached keyword search filters before ranking. Online search still
  receives a global top-N, so permitted records can be missed; no completeness claim.
- Both ordinary and planned tool executions enforce the same authority. A model
  cannot invoke an unoffered tool or relax group settings. Planner synthesis uses
  Clint's actual prompt; final filtering also covers its early return.
- Shared-channel raw project-file access is disabled pending a published-document
  boundary: authorizing a project cannot authorize its credentials/runtime files.
  Owner filesystem reads additionally reject sibling-prefix and symlink escapes.
- Web fetches from scoped conversations pin public IPv4 DNS answers and validate
  redirects; private/loopback/reserved destinations and oversized bodies are denied.
  IPv6-only web destinations are currently unsupported. Blocked-topic/canary rules
  also check search queries and fetch URLs. These pattern rules are defense in depth,
  not proof against every semantic prompt-injection attack.
- Slack inference and critique stay on local Qwen, with no cloud model fallback.
  Startup validates all classifier/planner/memory endpoints as loopback. Speculative
  search is disabled for Slack. Explicit web search still sends its query externally;
  “local-only” here describes model inference, not complete network isolation.
- Existing fuzzy web caches are not consumed by scoped requests. Diagnostic paths
  omit source text, generated goals/reasons and unrecognized tool names.
- The initial Slack tool policy is read-only because generation can be retried after
  a crash. Action tools need durable action IDs/reconciliation before enabling them.
  Dreams, source-grounded learning and autonomous code proposals remain separate
  workstreams; a Slack launch does not activate those workers or finish personalization.
- Slack answers explicit owner mentions in one private, unshared channel. No ambient
  participation or unrelated messages are ingested. The old small-model engagement
  module is preserved but was not wired into the current WhatsApp handler; it is not
  being represented as an active Slack answer gate. Category classification remains
  in the core with its existing fallback behavior.

## Configuration and installation prerequisites

Create the app from `integrations/slack/app-manifest.json`: `app_mentions:read`,
`chat:write`, `groups:read`; Socket Mode app token: `connections:write`.
Verify the exact permission grant, team, app, owner and channel in Slack's UI.
Use one private unshared channel, initially containing James and Clint only.

Store credentials only in root-owned mode-0600 `/etc/clint-slack/runtime.env`:

```dotenv
SLACK_APP_TOKEN=<app token>
SLACK_BOT_TOKEN=<bot token>
SLACK_APP_ID=<verified app>
SLACK_TEAM_ID=T0C2CKVEPKJ
SLACK_CHANNEL_ID=<verified private channel>
SLACK_OWNER_ID=<verified James user ID>
SLACK_MODEL_URL=http://127.0.0.1:11435
SLACK_MODEL_ID=qwen3.8-27b
SLACK_CHANNEL_POLICY={"mode":"colleague","blockedTopics":[],"allowedProjects":[]}
EVO_LLM_URL=http://127.0.0.1:11435
EVO_CLASSIFIER_URL=http://127.0.0.1:11435
EVO_PLANNER_URL=http://127.0.0.1:11435
EVO_CHAT_MODEL=qwen3.8-27b
EVO_MEMORY_URL=http://127.0.0.1:5100
EVO_MEMORY_ENABLED=false
```

The classifier URLs above use the already-loaded model. They do not establish that
a separate small model has been restored. Do not load/swap unrelated models implicitly.
Keep memory disabled for the initial installation probe; enable scoped memory only
after the live source attribution and intended channel policy have been verified.
Do not inherit the old agent's .env, Google refresh token or cloud model keys.

## Verification and release path

`npm run verify` is the canonical command. `../stage_slack_release.py` creates a
source-hashed EVO stage, installs the lockfile in a clean environment, runs verify,
and invokes the real shared-core synthetic Qwen probe. Inspect its replies: codeword
and blocked-topic assertions alone do not certify personality or factual quality.
Evidence is in `../evidence/slack-stage.json` and `../evidence/slack-evo-*`.

After these checks and independent review pass, install the full reviewed core
source and pinned production dependencies into a versioned root-owned directory
under `/opt/clint-slack/releases/`. Preserve the prior source symlink and unit.
The initial transport-only subset is insufficient for core imports. Run with Node
22 and `--import tsx`, as in `npm run slack` and the supplied systemd unit.

Prepare `/var/lib/clint-slack/data` from reviewed bundled defaults only; the unit
binds it over the release's data directory so runtime writes remain separate from
read-only source. Do not copy the old live runtime or archives as an incidental step.
On subsequent releases, preserve this state. Validate the unit with systemd-analyze,
then start only `clint-slack`; enable boot startup after the entry journey passes.

Actual entry proof: authenticate installation, confirm private/unshared channel,
owner mention -> threaded answer, second mention -> thread recall, restart -> no
duplicate delivery and retained recall. Verify non-owner/other-channel events are
rejected. Health endpoints and model probes do not substitute for Slack delivery.

Rollback: stop only Clint's Slack service, restore the previous symlink/unit and
restart after verification. Preserve SQLite and runtime state. An uncertain Slack
send is never automatically retried; inspect the originating thread before recovery.
Channel metadata is rechecked before generation and sending, but Slack offers no
atomic check-and-post transaction; administrator changes can race those checks.

Full archive analysis, broader autonomous learning, small-model restoration and
the existing WhatsApp service repair are not complete merely because this adapter
passes its release checks.
