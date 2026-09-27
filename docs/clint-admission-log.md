# Admission log (v41)

Owner direction, 27 September 2026: "build the admission log".

## Why

On 27 September the owner asked Clint why a message of 26 September had gone unanswered. Clint
had no record of the message and offered a cause it could not have known. Clint's gate discards a
refused message without keeping anything, so no true answer was available to it.

## What changed

| Part | Change |
|---|---|
| `src/slack/admission-log.js` (new) | Records a message the gate refuses: time, channel, kind of sender, reasons. The exceptions are listed below |
| `src/slack/admission-tools.js` (new) | Tool `admission_log`, which reads the record |
| `src/slack/inbox-admission.js` | The decision is made as before, then a refusal is recorded |
| `src/slack/main.js` | Opens the log on the inbox database and passes it to the handler |
| Permission and offering | `admission_log` is permitted to the owner in the private Slack channel, and offered there in every category |

## The gate is unchanged

`src/slack/policy.js`, `workspace-channels.js`, `channel-access.js` and `peer-lane.js` are not
edited. `acceptMention` decides as it did in v40.

- **The record is made after the decision.** `admitEvent` calls the same sequence as v40, takes its
  result, and only then calls the log. The log returns nothing the handler uses.
- **A failing log changes nothing.** The log catches its own failures and reports them to the
  journal as `admission_log_failed` with a fixed error class. `admitEvent` also catches anything a
  log throws, and anything the journal throws when told of it. If the log cannot be opened at
  startup, `admission_log_unavailable` is reported and Clint runs without it.
- **The reasons are worked out separately** by `refusalReasons`, which repeats the gate's
  conditions. It cannot affect the gate. A test runs both over more than 1,600 events and
  requires that the gate refuses exactly when there is at least one reason. The reviewer of this
  release ran both over 5.2 million and found no disagreement.

## What is recorded

One row for each refused message:

| Column | Content |
|---|---|
| `created` | When Clint received the event |
| `place` | `private`, `public`, `lane` or `other` |
| `channel` | The channel's Slack ID, if it has the form of a channel's. This includes a channel Clint is in but does not answer in. A direct conversation's ID is not stored |
| `ts`, `thread` | The message's Slack timestamp and its thread's, if they have the form of one |
| `sender` | `owner`, `app_as_owner`, `app`, `person` or `unknown` |
| `reasons` | One or more fixed words, listed below |
| `event_id` | Slack's event ID, if it has the form of one |

- **No message text is recorded.** There is no column for it.
- **No person's ID or name is recorded.** A sender is one of five kinds. `app_as_owner` means an
  app posted the message under the owner's name.
- The inbox database already holds the full text of accepted messages. This table adds less than
  that for refused ones. It does add something v40 did not keep: for 14 days, the time and
  channel of every refused message in every channel Clint is in.

Not recorded:

- Clint's own posts, which Slack sends back as events, and edits and deletions of them. A post
  made with Clint's token by another service carries Clint's app ID and is treated the same.
- Events that are not messages, such as reactions and joins.
- A second event for a message already accepted, where the inbox refuses it as a duplicate. A
  message that mentions Clint arrives twice.
- A second event for a message already recorded, and a redelivery of an event already recorded.
  The first record stands.
- An edit Slack reports when the text has not changed, as when it adds a link's preview.
- A refusal beyond 120 in an hour in the same place.
- A message on which the gate did not decide because Slack could not be asked about the sender.
  The handler fails as in v40 and Slack sends the event again.
- Anything while the log could not be opened.

## Reasons

| Reason | Meaning |
|---|---|
| `sent_by_app` | Posted through an app or integration, not typed by a person |
| `not_addressed` | Did not contain the word Clint or a mention of Clint |
| `not_owner` | In the private channel, from someone other than the owner |
| `edited` | An edit to an earlier message |
| `deleted` | The deletion of a message |
| `file_attached` | Had a file attached. The gate does not accept a message with a file; that is v40's behaviour and is not changed here |
| `thread_reply_broadcast` | A thread reply also sent to the channel |
| `me_message` | Sent as a /me message |
| `other_subtype` | Any other kind Slack marks specially, such as a notice that someone joined |
| `channel_not_served` | In a channel Clint is a member of but does not answer in |
| `empty_or_too_long` | No text, or more than 12,000 characters |
| `sender_not_authorised` | Slack did not confirm the sender as a current member |
| `channel_not_authorised` | Slack did not confirm the channel |
| `daily_limit` | 100 messages already accepted in the preceding 24 hours |
| `event_type`, `envelope`, `sender_not_identified`, `malformed_timestamp`, `other_workspace`, `external_shared_channel`, `own_message`, `lane_refused` | The event's form or origin |
| `unclear` | Refused, and none of the above identified |

- Where several conditions fail, all are recorded. A message posted by an app that also lacks
  Clint's name has both reasons. So has a message with a file that lacks Clint's name.
- `envelope`, `event_type`, `edited`, `deleted` and `other_subtype` are recorded alone. An edit
  or a deletion is about another message, and the rest of such an event does not describe it.
- The kinds of message Slack marks with a subtype are taken from its documentation as the
  reviewer and the author recall it. Slack was not observed. A kind not in the table is recorded
  as `other_subtype`, which says only that Slack marked it.
- The lane's own reasons are not broken down. The lane is off in the runtime's settings as they
  stood on 27 September 2026.

## Limits on size

| Limit | Value |
|---|---|
| Rows kept | The newest 1,000 for each place |
| Age kept | 14 days, or less where a place reaches its 1,000 rows sooner: at 120 an hour that is a little over 8 hours |
| Rows recorded in any hour | 120 for each place. Beyond that refusals in that place are not recorded, and the journal says so once an hour |

Each place has its own limits, so a busy public channel cannot keep a private refusal out.
Pruning runs on each insert.

## The tool

`admission_log` takes `hours` (1 to 336, default 48). It returns:

| Field | Content |
|---|---|
| `recording` | Whether this run of Clint opened the log. If not, the rows are from earlier runs and `limits` says so first |
| `refused` | The newest 30 refusals in the period: London time with GMT or BST, place, channel ID, whether in a thread, kind of sender, up to 8 reasons |
| `refusedTotal`, `refusedNotShown` | How many there were, and how many are not in the list |
| `legend` | A sentence for each reason that appears |
| `acceptedNotAnswered` | Up to 15 accepted messages not yet answered: time, place, channel ID, state, error code, attempts |
| `answered` | How many were answered, and the times of the newest 10 with the time of each reply |
| `oldestRecordKept` | The time of the oldest row still kept. It is not the time the log started |
| `limits` | What the log cannot show |

- A refusal is left out of the list once the same message has been accepted through another
  event.
- **What is printed is a word from a fixed list, or has a fixed form, whatever the database
  holds.** Place is one of four words and sender one of five. A reason is one of those above. A
  state is one of eight. A channel has the form of a channel's ID. An error code is lower-case
  words joined by underscores or colons, a system error name, or an error class. Anything else is
  printed as `unlisted`, or for a reason `unclear`. A person's ID has none of these forms.
- The tool opens the database read-only, at `slack.sqlite` beside the owner's task store, whose
  path the Slack adapter puts in the request's scope from its own setting.
- The largest result the tool can give is under 20,000 characters, within the limit of 24,000
  for a result passed whole.

## Who can use it

| Audience | Permitted | Offered |
|---|---|---|
| Owner in the private channel, open policy | Yes | In every category |
| Anyone in the public channel, including the owner | No | No |
| The peer lane | No | No |
| A caller with no scope, or on another transport | No | No |
| Anyone else | No | No |

The tool checks the scope itself as well as `permitsTool`, and refuses a scope from which any
part is missing.

## Known limits

- **The log starts when v41 starts.** It cannot explain anything before that, including the
  message of 26 September.
- **A message sent while Clint was not running is not in the log.** The author's understanding is
  that Slack does not deliver it later; that was not tested. The tool's `limits` field says so.
  Absence from the log is not a reason.
- The model matches the owner's message to a row by time. Nothing forces it to match correctly or
  to report only what the row says. That is a question for the trial.
- If the owner edits a message after Clint has answered it, the edit is recorded as a refusal
  with the reason `edited`, a few seconds after the answered message. The tool lists both.
- Each refusal costs one read and two writes to the database before the event is acknowledged to
  Slack. The reviewer measured 1 to 2.5 milliseconds on a Windows machine. It has not been
  measured on the EVO. If another process held a write lock on the inbox, each refusal would wait
  up to 3 seconds for it. Nothing else is known to write the inbox.
- Nothing removes old accepted messages from the inbox. The tool searches it by its index, so
  its size does not slow the tool: tested at 20,000.
- The wiring in `src/slack/main.js` is tested by reading its source, not by running it.
- That the database is opened read-only is not tested.

## Trial

In the private channel:

1. Post "what is the time" (without Clint's name). Clint does not answer. Then: "Clint, why did
   you not answer my last message?" Pass: Clint calls `admission_log` and says the message did
   not contain its name, with the time.
2. Post a message to Clint with a file attached. Then ask why it was not answered. Pass: Clint
   says it had a file attached. This also shows whether Slack marks such a message as the
   author expects.
3. "Clint, why did you not answer my message on 26 September?" Pass: Clint says the log has no
   record that old, and gives no cause.
4. In the public channel the owner asks question 1. Pass: Clint does not call the tool.
