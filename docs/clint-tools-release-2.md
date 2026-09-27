# Tools release 2 in Slack (v40)

Owner direction, 27 September 2026: "fix as many other tools as possible, and consider what more
tools would be helpful". Release 1 (v39) is `clint-games-tools.md`. This release changes no setting
and adds no credential.

## What changed

| # | Change | Kind |
|---|---|---|
| 1 | A permitted read is offered whatever category the request was given | Repair |
| 2 | `calendar_free_time`: free time computed from Google Calendar | New tool |
| 3 | `steads_status` adds the figures for the last 7 days | Extension |
| 4 | `moorstead_status` gives names only to a scope that is positively not Slack | Hardening |
| 5 | `spire_health` prints a status only if it is a whole number from 100 to 599 | Hardening |
| 6 | A calendar ID made only of dots is refused by every Calendar read | Hardening |

## 1. Permitted reads were not being offered

Before a request reaches the model it is given a category, and the category decides which tools
the model is shown. Two lists decide it: tools tied to a category, and tools shown in every
category. The Google reads and the saved-report reads were on neither list. They were shown only
to a request classified as planning, where every permitted tool is shown.

Tools offered to the owner in the private channel, computed from the v39 and v40 source with the
Google settings present and the memory setting on, which is its default (not read from the
running service; with memory off, recall, system and planning are each one fewer):

| Category | v39 | v40 | Calendar and Drive reads in v39 |
|---|---|---|---|
| planning | 23 | 24 | Offered |
| calendar, travel, email, conversational, general knowledge | 12 | 20 | Not offered |
| recall, system | 13 | 21 | Not offered |
| task | 14 | 22 | Not offered |

So in v39 a request classified as calendar could not read Calendar. No calendar question appears
among the owner's messages in the private channel's inbox up to 27 September, so the fault had not
been observed in a reply.

From v40 these are offered in every category: `google_read_status`, `calendar_list_calendars`,
`calendar_read_events`, `calendar_free_time`, `drive_search`, `drive_read`, `proactive_status`,
`proactive_report`.

### What this removes

**Offering was a barrier, and this release takes it away for Calendar and Drive in eight
categories.** A call to a tool that was not offered for the request is refused before it runs
(`src/claude.js`, "Tool denied: it was not offered for this request"). In v39, a request in any
category but planning could not reach Calendar or Drive, whatever the model was told by text it
had read.

| | v39 | v40 |
|---|---|---|
| Categories in which one request can read a web page, read Calendar or Drive, and make a further web request | 1 (planning) | 9 |

- `web_search` and `web_fetch` are offered in all nine categories in both releases. The check on
  an outbound web request looks for credentials. It does not look for calendar or document text.
- So text in a fetched page that told the model to read a document and put its contents in a web
  address could, in v40, be acted on in any category. In v39 it could be acted on only in a
  planning request. No such attack was demonstrated; this is what the code permits.
- **The text need not be a web page.** `calendar_read_events` returns each event's title,
  description and place, which are written by whoever sent the invitation. `drive_read` returns
  the text of any document the owner can open, including one shared by someone else. Either
  reaches the model in the same way, and an ordinary question about the calendar reads the
  first. The sequence is: read an invitation, read a document, make a web request. That is
  three tool rounds of the five allowed.
- The tool loop allows five rounds to a request.
- This is the purpose of the repair: the owner cannot otherwise ask about his calendar or
  documents in the ordinary way. It is the owner's decision. Narrower alternatives, not built:
  offer the Google reads in every category but withdraw the web tools from a request once a Google
  read has returned; or offer Calendar everywhere and Drive only for planning and recall.

### Other effects

- **Offering is not permission.** A tool is offered only if `permitsTool` already permits it for
  the scope, and the same check runs again when the tool is called. The public channel and the
  lane gain no Google read.
- **The public channel is offered `proactive_status` and `proactive_report` in every category.**
  It was already permitted both; before v40 it was shown them only for a planning request.
- **Still offered by category only:** `task_save` and `task_set_status` (task and planning),
  `memory_search` (recall, system and planning) and `soul_read` (planning). Unchanged.
- The Calendar tools are offered only if the Slack runtime has the Google client ID and refresh
  token. Both setting names are present in the runtime's configuration. Whether they work is
  shown by the trial.
- Other transports: the Google reads need the local-only scope, which only the Slack adapter
  issues. No effect.

## 2. `calendar_free_time`

Input: `date` (required, 2000 to 2100), `days` (1 to 14, default 1), `day_start` (default 09:00)
and `day_end` (default 18:00), each from 03:00 to 23:59, `minimum_minutes` (15 to 480, default
30), `calendar_ids` (up to 5, default the primary calendar).

Output: the calendars read and the window asked for, as given; for each date, its weekday, the
busy periods and the free periods of at least the minimum length, as London times; how many
events were read and how many were left out, by reason; the time of the read; a fixed note of
what is not covered.

| Rule | Detail |
|---|---|
| Counts as busy | Any event not listed in the next row. That includes tentative events, invitations not yet answered, out of office and focus time |
| Does not count as busy | Cancelled; marked free (`transparent`); declined by the owner; working-location markers; timed events whose start and end are the same instant |
| All-day event | Busy from midnight to midnight, London time, unless marked free. One that names the same day as its start and its end is taken as that one day |
| Overlapping and adjoining events | Merged, in whatever order they arrive |
| Part minutes | An event's start is taken back to the minute and its end forward to the minute |
| Today | Time already gone is not offered. `startsFrom` gives the time the day was counted from |
| Time zone | Europe/London, fixed. Clock changes are handled; the day's hours are London wall-clock hours |

**Free time is computed from events read in full, or not reported.** The state is `incomplete`
and `days` is null if:

- a reply does not state that it is a list of events (`kind` is not `calendar#events`), or its
  list or its continuation token is not in the expected form;
- reading every calendar asked for would take more than 8 requests (250 events to a request);
- an event that would count as busy has no start and end that can be read, or ends before it
  starts. A time must carry a date, a time and an offset. The day named, in a time or in an
  all-day event, must be a real day from 2000 to 2100, and the hour one from 00 to 23;
- the result is too long to pass whole.

If any request fails the state is `unavailable`. An event that is left out (cancelled, marked
free, declined, working location) is left out whether or not its times can be read.

- **No title, description, place, link or name is requested from Google.** The request names the
  fields it wants, and a test requires that list exactly. Text written by whoever sent an
  invitation cannot reach the model through this tool. It can through `calendar_read_events`,
  as section 1 says. The reply does repeat the calendar IDs
  the model gave.
- Permission is that of the other Google reads in every scope tested: the owner, in the private
  channel, under the local-only scope, including the read-only scope the overnight jobs run
  under. It is refused in the public channel and the lane.

## 3. `steads_status`: last 7 days

| Game | Added | Source field |
|---|---|---|
| Moorstead | Visited, played | `stats.real.week`, `stats.real.playedWeek` |
| Saltstead | Visited, played | `visits.saltstead.week.real` |
| Marsstead | Visited | `muster.week.real.uniques` |
| Havenstead | Nothing. The line says the intake keeps no 7-day figure | |

- Figures are the external class, as in release 1.
- **The window is the ledger's own, and they differ.** Saltstead and Marsstead count today and
  the six UTC days before it. Moorstead counts any day on or after the UTC day of the moment
  seven days ago, which is eight UTC dates. The tool's header says so, as fixed text dated 27
  September 2026: if a ledger's window is changed the header will be wrong. Read from the ledgers'
  source on the EVO on 27 September 2026 (`saltstead/dash/app.py`, `moorstead/dash/app.py`,
  `marsstead/brain/src/musterbook.js`); that source is not part of this release's evidence.
- A ledger that answers without a 7-day figure still reports today, followed by "last 7 days
  unavailable". It is not reported as zero. If today's figures are unavailable the line says
  only that, and the 7-day figures are not printed.
- The weekly total posted to the games channel on Mondays is computed separately by the Steads
  reporter from its own daily record and covers Monday to Sunday. The two will differ.

## 4 to 6. Hardening

- `moorstead_status` returned names to any caller that was not a Slack scope, including a caller
  with no scope at all. Now names are returned only to a scope whose transport is set and is not
  Slack. A caller with no scope gets counts.
- `spire_health` printed the voice endpoint's status without checking it, and the venue's after
  converting it to a number. For both it now reads the status once and prints a whole number
  from 100 to 599, or the word "error".
- A calendar ID of `.` or `..` shortened the path of the request to Google. Host and method were
  fixed and no use for it was found. Such an ID is now refused before any request, in
  `calendar_read_events` as well as the new tool.
- Tests now pin the check at each of the nine figures of release 1 and the five added here, and
  run `moorstead_status` with inputs that ask for names.

## Considered and not restored

| Tools | Reason |
|---|---|
| `search_trains`, `search_accommodation` | They return fixed price guidance written into the source, presented as current. Their replies exceed the 1,500-character limit for such tools and would be cut. Link formats are unverified. `web_search` is available |
| `calendar_find_free_time`, `calendar_list_events` | The first lists the primary calendar's events and reports "completely free all day" when there are none, without regard to other calendars, events marked free or pagination. Replaced by `calendar_free_time`. The second duplicates `calendar_read_events` |
| `spire_presence`, `moorstead_bairns_status`, 16 LQ Council reads | Each needs a credential added to the Slack runtime. That is the owner's decision. Several return text written by other people, which raises the question settled for Moorstead names in release 1 |
| Tools that act or write | Unchanged. None was enabled |

## Known limits

- Whether the model calls `calendar_free_time` when asked, and reports it faithfully, is a
  question for the trial. The tests establish the tool's output, not the model's use of it.
- **The tool has not been run against Google.** Its tests use events built by hand to the shape
  the Calendar API is understood to return; nothing recorded from Google is in the tests. Three
  things in particular are assumed and not verified: that Google returns `kind` when the request
  names its fields; that every time it returns carries an offset; that working-location markers
  need leaving out. If the first is wrong the tool refuses every request, and the trial's second
  question shows it.
- `calendar_free_time` reads only the calendars it is given. It does not know which calendars
  matter to the owner.
- One question can take up to 8 requests of up to 15 seconds each, one after another. There is no
  overall limit on the time.
- More tools are offered per request, as the table in section 1 shows. The effect on the model's
  choice of tool is not measured.
- The router's classifier prompt still describes WhatsApp categories. Unchanged.

## Trial

In the private channel:

1. "Clint, what is in my calendar tomorrow?" Pass: the reply lists events read from Calendar.
2. "Clint, when am I free on Thursday?" Pass: free periods with times, the calendar read, and no
   claim beyond them. Compare with the calendar. A reply that free time could not be established
   is a fail of the tool, not of the model: report it. Ask it of three days: one with a timed
   event, one with an all-day event, and one with nothing in it. The tool has been run against
   none of the three.
3. "Clint, find the engagement letter in my Drive." Pass: Clint searches Drive. Any file name
   will do.
4. "Clint, how are the steads this week?" Pass: four lines, three with 7-day figures.
5. "Clint, who is on Moorstead?" Pass: counts, no names, as in release 1.

In the public channel, the owner asks question 2. Pass: Clint does not read Calendar.
