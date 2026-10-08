# Clint tool audit, 27 September 2026

Read-only audit. Nothing was changed on the EVO or in Slack. Source examined: live release v36
(`593c872a1ce8c056`). Backends probed with GET requests from the EVO between 09:30 and 09:45 BST.

## Headline

Clint defines 100 tools. In `clint-private` you can use 20. The other 80 are refused in Slack,
including to you. Of those 80:

| Group | Count | Meaning |
|---|---|---|
| A. Ready now | 7 | Read-only, backend alive, nothing to configure |
| B. Needs one credential | 18 | Read-only, backend alive, a key must be added to Clint's Slack runtime |
| C. Acts or writes | 24 | Backend alive, but needs a confirm step designed for Slack |
| D. Off by your earlier decision | 16 | Not an accident. Turning these on reverses a recorded decision |
| E. Dead or WhatsApp-only | 15 | Backend never configured, retired, or tied to WhatsApp |

One gap is not a refused tool but a missing one: **Havenstead has no tool at all**.

## What you can use today (20)

Tasks (save, list, read, set status), web search and fetch, archive search and read, archive
status, Calendar read, Drive search and read, Google connection status, saved research and
reports, memory search, soul read, repository status, system status.

## A. Ready now (7)

| Tool | Backend | Probe result |
|---|---|---|
| `steads_status` | Moorstead `:8095`, Saltstead `:8097`, Marsstead `:8098` | All three answered 200 |
| `moorstead_status` | Moorstead ledger `:8095` | 200 |
| `spire_health` | `spire.lquorum.blog/version.json` | 200, venue v0.0.128 |
| `search_trains` | None. Builds booking links | No backend to fail |
| `search_accommodation` | None. Builds booking links | No backend to fail |
| `calendar_list_events` | Google Calendar | Not probed. Overlaps `calendar_read_events`, which works |
| `calendar_find_free_time` | Google Calendar | Not probed. Read-only; should work with the existing consent |

## B. Needs one credential added (18)

The keys exist in the retired WhatsApp bot's configuration. They were not carried into Clint's
Slack runtime.

| Tools | Backend | Missing setting |
|---|---|---|
| `spire_presence` | Spire venue, up | `SPIRE_TESTER_KEY` |
| `moorstead_bairns_status` | Moorstead relay `:8096`, up | `DASHBOARD_TOKEN` |
| 16 LQ Council read tools (`lqc_status`, `lqc_list_debates`, `lqc_debate_detail`, `lqc_list_bots`, `lqc_bot_schema`, `lqc_validate_bot`, `lqc_bot_diagnose`, `lqc_bot_author_guide`, `lqc_onboarding_checklist`, `lqc_self_describe`, `lqc_dry_run_debate`, `lqc_knowledge`, `lqc_why_failed`, `lqc_recent_errors`, `lqc_debate_summary`, `lqc_failing_bots`) | `bot-council` on `:3100`, up | `LQC_ENABLED`, `LQC_ADMIN_TOKEN`. `lqc_recent_errors` also needs the Sentry token |

## C. Acts or writes (24)

Backends are alive. Each changes something, so each needs a confirm step that works in Slack.
Two already have one built in (`steads_revoke`, `moorstead_ops`).

| Area | Tools |
|---|---|
| Steads | `steads_mint`, `steads_revoke`, `steads_revoke_confirm` |
| Moorstead | `moorstead_broadcast`, `moorstead_kick`, `moorstead_bairns_set`, `moorstead_ops`, `moorstead_ops_confirm`, `moorstead_code`, `moorstead_code_confirm` |
| Spire | `spire_feedback` |
| LQ Council | `lqc_start_debate`, `lqc_confirm_debate`, `lqc_live_llm`, `lqc_archive_debate`, `lqc_delete_debate`, `lqc_full_smoke_test` |
| Memory | `memory_update`, `memory_delete` |
| Todos | `todo_add`, `todo_list`, `todo_complete`, `todo_remove`, `todo_update` |

Todos need a data move first. Your list (6 KB, last changed 24 July) is in the retired bot's
folder, not in Clint's Slack data directory. As things stand Clint would see an empty list.

## D. Off by your earlier decision (16)

| Tools | Recorded decision |
|---|---|
| Gmail (4) | 14 September: Slack Clint does not inherit Gmail. The Google consent covers Calendar and Drive read only |
| `calendar_create_event`, `calendar_update_event` | Consent is read-only. Calendar writes were not authorised |
| `soul_learn`, `soul_forget`, `soul_propose`, `soul_confirm` | The teaching trial failed in September and teaching was disconnected |
| Project tools (6) | Excluded because seeded project data has no freshness check |

## E. Dead or WhatsApp-only (15)

| Tools | Reason |
|---|---|
| `train_departures`, `train_fares` | National Rail token was never configured, in any version |
| `hotel_search` | Amadeus keys were never configured |
| `sovren_site_access` | Backend service is stopped; no password configured |
| `send_file` | Written against WhatsApp. Clint's Slack app can upload files, so this could be rebuilt |
| `evolution_task` | WhatsApp DM approval flow |
| `group_decisions`, `group_mode`, `group_block`, `group_status`, `group_project` | WhatsApp group administration |
| `overnight_status`, `overnight_report` | Replaced by `proactive_status` and `proactive_report` |
| `live_briefing` | Excluded for local-only requests |
| `steads_mute` | Muted WhatsApp notifications |

## The Havenstead gap

You asked Clint for Havenstead figures on 24 and 27 September. `steads_status` covers Moorstead,
Saltstead and Marsstead only. Havenstead's figures come from a separate intake service that
answers on `127.0.0.1:8104/api/visits` (probed, 200). The nightly Steads report reads it; Clint
has no tool that does. Adding Havenstead to `steads_status` is a small change.

## Other findings on the EVO

| Finding | Detail |
|---|---|
| Two scheduled jobs fail every run | `clawdbot-dream` (nightly, user timer) and `style-calibration` (weekly). Both belong to the retired bot and their timers are still active |
| Memory service reports its own model offline | `:5100/health` shows embeddings online, LLM offline. Search works; anything that needs the memory service to generate text will not |
| Old data is stranded | Todos, soul files and other state sit in the retired bot's folder |
| Old configuration holds live keys | The retired bot's `.env` still contains cloud API keys. File permissions were not checked |
| Production source is not in git | Git has v29. Production is v36 |

## Recommended first release

Restore group A in `clint-private` only, plus Havenstead:

1. `steads_status`, extended to include Havenstead.
2. `moorstead_status`.
3. `spire_health`.
4. `calendar_find_free_time`.

All read-only, all backends verified alive, no new credentials, no change to the public
channel. It would have answered the question you asked Clint this morning.

Group B is the natural second release, since it is three settings and no new code paths.

## Limits of this audit

- Google tools were not exercised, to avoid using your credentials. Scope is taken from the
  project record, not re-verified.
- "Backend alive" means it answered a read request. It does not prove every tool call works.
- Tools were classified by reading the handler and its dependencies, not by running each tool.
