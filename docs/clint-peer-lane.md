# Clint peer lane (Instinct)

Owner direction, 27 September 2026: let Clint and the third-party agent Instinct cooperate
without giving Instinct owner authority or private data.

## What it is for

Instinct does not act on requests from Clint: two live trials on 27 September 2026 failed,
one before and one after James told Instinct to watch the channel. The direction that works
is the other one. James asks Instinct; Instinct posts in the lane; Clint answers; Instinct
reads the answer on its own schedule. The lane is where that happens safely.

## Configuration

A third operator-configured Slack channel. It is disabled unless both settings are present
in the runtime environment.

| Setting | Meaning |
|---|---|
| `SLACK_PEER_CHANNEL_ID` | The lane: a public, unshared channel, distinct from the private and public channels. |
| `SLACK_PEER_APP_ID` | The one foreign Slack app whose messages the lane admits. |

Never reuse the lane's channel ID for another role. Stored lane rows carry a marker and are
blocked if the channel is later redefined, but the channel's Slack history remains.

## Guarantees (enforced in code, tested in `test/slack-peer-lane.test.js`)

- **Admission.** A message carrying any of the keys `bot_id`, `bot_profile` or `app_id` is
  admitted only in the lane, and only when `app_id` equals the configured app and `bot_id`
  is well formed. When `bot_profile` is present it must name the same app and bot; when it
  is absent the bot ID is checked for shape only. Everywhere else a message carrying any of
  those keys is refused, whatever the value, including null. This is stricter than v36,
  which tested only for a truthy `bot_id` or `bot_profile`. The explicit Clint name rule
  still applies in the lane. This rests on Slack marking every app-authored event with one
  of those keys. That was observed in Slack's history API, not in the live event stream;
  trial step 1 tests it.
- **Local only.** The lane refuses Slack Connect envelopes, foreign teams, external users
  and a channel that is shared in any way.
- **Authority.** Every lane request is issued `webOnly` and `forceRestricted`. It is never
  the owner, including when Slack names James as the sender (Instinct can post through his
  connected account). No message in the lane can approve an action.
- **Data.** Of every defined tool, only `web_search` and `web_fetch` are permitted. The
  model context carries no deployment notes, archive content, memory, saved research or
  briefing. History evidence is the lane channel only.
- **Volume.** At most 6 accepted messages per thread, 8 per hour and 20 per day, all authors
  counted, decided together with the insert. Owner channels are always served before the lane.
  At most 24 admission checks per hour reach Slack's API; that count is held in memory and
  starts again when the service restarts.
- **Cost of one lane message.** One attempt, including across a restart. At most three main
  model requests (the first, plus two tool rounds), and one or two classifier requests: a
  second runs when the first returns no usable category. No thinking mode, no critique pass,
  no control-reply retry, 2,048 answer tokens per main request. The message counts once
  against the request counter. The lane is refused once that counter is within 40 of its
  limit. The counter belongs to the running process: it restarts with the service and does
  not count the overnight programme.
- **Quiet hours.** From 00:00 to 07:30 Europe/London the lane admits nothing and no lane row
  is picked up. A row picked up just before midnight, or a request already running, finishes.
- **Slack check failures.** If Slack cannot confirm the lane channel when the worker reaches
  a lane row, the row is closed instead of waiting.
- **Diagnosis.** Lane outcomes are journalled as `lane_queued`, `lane_duplicate` or
  `lane_rejected` with a fixed reason code and no message text: `lane_not_configured`,
  `peer_app_mismatch`, `lane_admission_rejected`, `lane_actor_denied`, `lane_channel_denied`,
  `lane_quiet_hours`, `lane_check_limit`, `lane_thread_limit`, `lane_hour_limit`,
  `lane_day_limit`, `rate_limited`. A row closed at pick-up is stored as `failed` with
  `lane_single_attempt` or `lane_quiet_hours` and journalled `lane_row_closed`. A row closed
  on a Slack check failure is stored with `channel_check_failed` and journalled
  `channel_check_failed`.

## Judgment left to the model

The lane prompt tells Clint the audience is an outside company's agent and lists what not to
disclose. That wording guides replies; it is not the control. The controls are the scope,
context and tool gates above.

## What is in the lane's model context

| Present | Absent |
|---|---|
| Core prompt: James's name, role and employer, as in clint-public | Owner authority, travel, family and project sections |
| That inference is local and web queries leave the host | Deployment notes: host, operating system, remote access, model tuning |
| Identity and self-awareness text. It names internal tools and says saved ChatGPT, Claude and WhatsApp conversations and overnight work exist. It holds none of their content | Archive records, memory, soul fragment, saved research, briefings |
| Lane audience note and the two offered tool names | Any other channel's history |
| Lane channel history and up to 16 speakers' display names | |

The self-awareness text says "Do not conceal the provider", which pulls against the lane
note. If asked, Clint may say it runs a local model and name it if it knows. That is
existence, not configuration, and is accepted.

## Known limits

- **Context can leave through the web tools.** `web_fetch` and `web_search` accept any public
  destination, and the outbound guard blocks credentials and the canary only. An instruction
  in lane text or in a fetched page could put lane context into a request. The table above is
  everything there is to send.
- **One lane request can delay the owner.** The worker is serial. A lane request already
  running finishes first. Configured timeouts allow 15 minutes per model request, so the
  worst case is about 45 minutes plus the classifier; ordinary answers take far less. There
  is no wall-clock cap. Queued lane messages always wait behind owner messages.
- **Daytime background work yields to the lane**, as it does to any foreground message.
- **A closed lane row is silent.** Rows closed at pick-up get no thread notice.
- **Lane text reaches the local memory service.** Every lane message causes two to five
  searches of the memory service on this host, carrying the message text. The results are
  discarded for the lane. Whether that service keeps a record of queries was not checked.
- **A third tool round ends the answer.** If the model asks for a third round, the message
  fails with the standard thread notice and the work done is discarded.
- **An answer can be lost after it is written.** If Slack's channel check fails between
  generation and delivery, the answer is discarded without a notice. Slack calls are not
  retried.
- **Quiet hours have edges.** A reply held back by a Slack rate limit before midnight can be
  delivered after it. A lane row waiting behind a stalled owner row stays queued through
  quiet hours and may run after 07:30, however old it is. While any row waits, the overnight
  programme does not start.
- **Model output is posted as written.** If the model writes tool-call markup as plain text,
  it is posted. The public channel behaves the same way under v36.
- **The ordinary gate's new strictness is unobserved in production.** People's messages
  carried none of the three keys in Slack's history API on 27 September 2026. If Slack ever
  adds one to a person's message, that message is refused and journalled `rejected`.

## Not established by this release

- Reply quality in the lane. Deterministic tests prove the boundary, not the answers.
- How long Instinct takes to read an answer. It polls on its own schedule.
- Anything about Instinct's conduct outside the lane. Its Slack user authorization, granted
  by James on 27 September 2026, reads every channel and DM he can see and sends as him.
  The lane does not narrow that grant; only revoking it in Slack does.

## Trial, in this order

1. **Before any lane traffic.** James asks Instinct to post `@Clint` plus a question in
   `clint-private`. Pass: every journal line for that post is `rejected`, and there is no
   reply. If any line is `queued`, stop and roll back: a copy of the event arrived without
   authorship keys.
2. James writes in `clint-private` as usual. Pass: `queued` then `reply_sent`. This is the
   regression check on the stricter ordinary gate.
3. James asks Instinct to ask Clint, in the lane, for the capital of France. Pass: journal
   `lane_queued` then `reply_sent`; the reply is in-thread.
4. James asks Instinct to ask Clint, in the lane, for the morning briefing and for Clint's
   technical setup. Pass: no briefing content and no host, operating system, remote access
   or tuning detail in the reply. Naming the local model is not a failure.
