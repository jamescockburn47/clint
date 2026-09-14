# Clint shared-core Slack release

## Current status

At 17:06 UTC, 14 September 2026, protocol `clint-shared-core-v5`, application release
`c1335e8c0868bab2`, is live on the existing `qwen3.8-27b` gateway for James's authorized
private testing. WhatsApp is retired. Write normally in `clint-private`; Slack DMs are
not connected. The channel now uses open policy, with membership checked to contain
exactly James and Clint in a private unshared channel. Read-only archive access is enabled.
The snapshot contains 76,065 indexed chunks (69,804 normalized source records); it is
not a live connection to ChatGPT, Claude or WhatsApp. General external web tools are
denied in archive-capable requests. The fixed public GitHub repository status tool remains
available; it cannot establish the local/unpushed checkout or deployment.

Current capability instructions reflect offered tools and the actual Slack scope. Fresh
`system_status` observations cover serving alias, host/CPU, Linux-managed and available
RAM, GPU allocation/use and deployed release. Unknown physical capacity or gateway-hidden
model details remain null. Old static self-awareness and Slack DM handoffs were removed.
Technical-description output passed independent comparison with its captured tool payload.
The broader capability screen remains failed on unsupported file-input and background-learning
claims. This is an imperfect owner-test build; personality activation and factual promotion
remain withheld. Three synthetic capability turns took 47–84 seconds.

The clean EVO canonical verification passed 1,463 tests, skipped one and failed none;
the existing five-call core probe passed its structural assertions. Independent review
covered source, actual outputs, privacy and rollback, including seven recovery cases.
Live installation preserved all 13 existing inbox rows. Authentication, exact channel
membership, archive hash/readability and actual runtime access passed as the service UID.
No Slack message was sent by the deployment probe; the next owner message supplies fresh
delivery evidence. Historical v4 delivery evidence below is not a v5 delivery claim.

The first live namespace canary found the optional archive `ReadOnlyPaths` ineffective.
The service was stopped and its external unit corrected to mandatory `BindReadOnlyPaths`
at both the real `/var/lib/private/clint-slack/data/knowledge` backing path and the app
alias. The application release stayed unchanged. Both actual child mounts are now `ro`;
both aliases returned `EROFS` to service-UID canary writes, and the archive hash is unchanged.
The unit SHA is `95a09c3547c7c39ab0abb7195c838b177b0b63fd9ad57fdbc280cbb70ee53104`.
Local unit source includes the correction and therefore differs from the earlier staged unit.
Evidence: workspace `evidence/updated-slack-live-proof-20260914.json`,
`archive-mount-correction-20260914.json` and `independent-updated-clint-release-review-20260914.md`.

Previous release `1bef73fd6eab11dc`, environment, unit, archive selection and state backups
are retained under `/var/backups/clint-slack/c1335e8c0868bab2`. Stop the service successfully
before any rollback mutation. Restore the previous source/unit/environment/archive selection,
retain compatible acknowledged inbox rows, then check version-specific readiness. Do not
overwrite newly acknowledged events with the historical inbox snapshot. The archive-mount
correction also retains its prior v5 unit as `archive-mount-before.service` in that directory.

Flash Next remains a candidate. The buffered/lazy-table configuration loaded and served
short requests in the existing 96 GiB GPU partition. Its previous literal-format screen
failed and is preserved. The next separate experiment tests the actual Clint adapter;
no Flash process is currently running and no model swap is part of this owner-test release.

## Historical releases

Earlier 14 September 2026 (protocol `clint-shared-core-v4`, release `1bef73fd6eab11dc`, deployed by the reviewed `--upgrade` path; controlled restart kept all 8 inbox rows with no duplicate delivery): WhatsApp is decommissioned;
Slack is the only conversational transport. Adapter changes, each with tests:

- An unavailable local core (`provider: unavailable`, open circuit breaker) no longer
  consumes one of the three delivery attempts; the message is requeued and retried on
  every drain for up to six hours, then failed with a thread notice.
- Slack platform refusals (`invalid_blocks`, `msg_too_long`, `not_in_channel`) are
  terminal `failed` rows with a thread notice; rate limits keep the generated reply and
  resend it on a later drain; only unknown transport outcomes remain `uncertain`.
- Every dropped message posts a short plain notice into its thread (no source or error
  text). Hourly, the journal reports counts of `failed`/`uncertain`/`blocked` rows.
- Journal lines carry a bounded error code (`detail`), never source text.
- A top-level channel message recalls the channel's ten most recent exchanges; a thread
  reply recalls its thread. Recall still requires `state='sent'`.
- `EVO_MEMORY_ENABLED=false` is now honoured by the memory client: no health probes,
  searches or queued writes reach `:5100`.
- Startup also rejects Tavily, Brave and Perplexity keys and a non-loopback SearXNG URL.
- The planner's private facts about James and the self-awareness project list are
  withheld unless the conversation permits private context; tool descriptions no longer
  name projects.
- A `max_tokens` truncation delivers the partial text flagged `meta.truncated`, instead
  of silence.
- `install_slack_release.py --upgrade` reads the readiness string from each release's
  own `src/slack/model.js`. The later v5 rollback retains compatible current inbox rows.

The manifest and policy accept un-mentioned owner messages; scopes are
`app_mentions:read`, `chat:write`, `groups:read`, `groups:history` with events
`app_mention` and `message.groups`. Sections below that say "mention @Clint" are historical.

Update at 22:18 BST, 13 September: release `63a09a8d6a92f9e6` accepts ordinary owner messages
in `clint-private`, including thread replies, without mentions. Slack's
`message.groups` subscription and `groups:history` grant are active. Other users,
channels, workspaces, bot messages and edited-message subtypes remain excluded.
The greeting regression is fixed: an actual unmentioned `hello` received
`Hi James.` in 20.02 seconds. Internal-only `[INVALID]`, `[SILENT]` and `[APPROVED]`
outputs are regenerated once per adapter attempt and rejected if still invalid;
the worker permits at most three attempts. The canonical suite passed 1,405 tests,
zero failed, one skipped. Independent review covered code and upgrade recovery.
The system category now uses fast Qwen mode too; its live probe took 33.86 seconds.
The prior release and a checked state/SQLite backup are retained at
`/var/backups/clint-slack/63a09a8d6a92f9e6`. The following initial-release evidence
remains historical; mention-only operation has been superseded.

The separate minimal-prompt pilot has been replaced in source. Slack now invokes
`LLMService.getResponse`: Clint's existing prompt, Cortex, category routing,
planner, tools, critique and deterministic outbound filter. The app and EVO service
are installed and running; boot startup is enabled. Release `fea2c02bc6066aba`
passed 1,402 tests (zero failed, one skipped), independent review and the actual
Slack entry journey. Three owner mentions received threaded replies in 21.78,
23.47 and 24.73 seconds. Recall survived a controlled restart with no duplicate
deliveries. Evidence is in the workspace-level `evidence/slack-live-release-proof.json`.
Do not use the superseded minimal-file deployment instructions.

James selected `clint-qtj3570.slack.com` (workspace `T0C2CKVEPKJ`) after LQ's app
limit blocked installation. This is distinct from the mistyped `clint-ktj3570`.
The private unshared channel is `clint-private` (`C0C1N0VKVUL`), containing James
and Clint only. Owner: `U0C1GAY9D0E`; app: `A0C1N0KGRNG`. Write normally in
the channel and in follow-up thread replies. Slack DMs are not connected. LQ remains
the eventual preferred workspace.

The initial channel ran colleague policy with read-only tools and archive memory
disabled. Thread recall is active. Broader personalization and learning have not
been activated by this deployment. Some generated capability descriptions still
refer generically to owner DMs or memory; those statements do not establish that
such Slack features are connected. Basic conversation/recall/email requests use
Qwen's non-thinking mode; planning, research and critique retain their settings.
A system-capability response took 104 seconds in the synthetic probe, so latency
outside the basic conversation path remains a limitation.

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
  search is disabled for Slack. Colleague-mode explicit web search sends its query externally;
  current open/archive-capable requests cannot invoke general web tools.
  “local-only” here describes model inference, not complete network isolation.
- Existing fuzzy web caches are not consumed by scoped requests. Diagnostic paths
  omit source text, generated goals/reasons and unrecognized tool names.
- The initial Slack tool policy is read-only because generation can be retried after
  a crash. Action tools need durable action IDs/reconciliation before enabling them.
  Dreams, source-grounded learning and autonomous code proposals remain separate
  workstreams; a Slack launch does not activate those workers or finish personalization.
- Slack answers owner messages in one private, unshared channel. Other people's
  messages are rejected before storage. The old small-model engagement
  module is preserved but was not wired into the current WhatsApp handler; it is not
  being represented as an active Slack answer gate. Category classification remains
  in the core with its existing fallback behavior.

## Configuration and installation prerequisites

Create the app from `integrations/slack/app-manifest.json`: `app_mentions:read`,
`chat:write`, `groups:read`, `groups:history`; events: `app_mention`, `message.groups`;
Socket Mode app token: `connections:write`.
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
SLACK_CHANNEL_POLICY={"mode":"open","blockedTopics":[],"allowedProjects":[]}
EVO_LLM_URL=http://127.0.0.1:11435
EVO_CLASSIFIER_URL=http://127.0.0.1:11435
EVO_PLANNER_URL=http://127.0.0.1:11435
EVO_CHAT_MODEL=qwen3.8-27b
EVO_MEMORY_URL=http://127.0.0.1:5100
EVO_MEMORY_ENABLED=false
```

The classifier URLs above use the already-loaded model. They do not establish that
a separate small model has been restored. Do not load/swap unrelated models implicitly.
Keep learned memory disabled; the explicitly installed read-only archive is separate.
Open policy requires exact private membership and authorizes that private archive context.
Do not inherit the old agent's .env, Google refresh token or cloud model keys.

## Verification and release path

`npm run verify` is the canonical command. `../stage_slack_release.py` creates a
source-hashed EVO stage, installs the lockfile in a clean environment, runs verify,
and invokes the real shared-core synthetic Qwen probe. Inspect its replies: codeword
and blocked-topic assertions alone do not certify personality or factual quality.
Evidence is in `../evidence/slack-stage.json` and `../evidence/slack-evo-*`.
`../install_slack_release.py` implements the reviewed first-install path and
requires a stage-matched zero-exit receipt and matching remote verification/probe
logs. Without flags it refuses an existing installation. The reviewed `--upgrade`
path retains state, the previous release and a SQLite backup. `--private-archive` pins
the separately uploaded source snapshot and activates the authorized private policy.
Rollback restores previous unit/release/configuration/archive selection if startup fails,
retaining compatible acknowledged inbox events. Readiness is read from the staged protocol.

After these checks and independent review pass, install the full reviewed core
source and pinned production dependencies into a versioned root-owned directory
under `/opt/clint-slack/releases/`. Preserve the prior source symlink and unit.
The initial transport-only subset is insufficient for core imports. Run with Node
22 and `--import tsx`, as in `npm run slack` and the supplied systemd unit.

Prepare `/var/lib/clint-slack/data` from reviewed bundled defaults only; the unit
binds it over the release's data directory so runtime writes remain separate from
read-only source. Always create its `knowledge` subdirectory: mandatory read-only binds
require an existing directory even before a source snapshot is installed. Do not copy the
old live runtime or archives as an incidental step.
On subsequent releases, preserve this state. Validate the unit with systemd-analyze,
then start only `clint-slack`; enable boot startup after the entry journey passes.

Actual entry proof: authenticate installation, confirm private/unshared channel,
owner mention -> threaded answer, second mention -> thread recall, restart -> no
duplicate delivery and retained recall. Verify non-owner/other-channel events are
rejected. The deployed policy counterexamples passed; no second real user was
introduced merely for testing. Health endpoints and model probes do not substitute
for Slack delivery.

Rollback: stop only Clint's Slack service, restore the previous symlink/unit and
restart after verification. Preserve SQLite and runtime state. An uncertain Slack
send is never automatically retried; inspect the originating thread before recovery.
Channel metadata is rechecked before generation and sending, but Slack offers no
atomic check-and-post transaction; administrator changes can race those checks.

Full archive analysis, broader autonomous learning and small-model restoration are not
complete merely because this adapter passes its release checks. WhatsApp is intentionally retired.
