# Games status tools in Slack (v39)

Amended by release 2 (v40), see `clint-tools-release-2.md`: `steads_status` also gives 7-day figures, and
`moorstead_status` gives names only to a scope that is positively not Slack. The corrections marked
"v40" below come from the third review of this release.

Owner direction, 27 September 2026: restore Clint's tools in Slack, starting with the ones that
only read and whose services are running.

## What changed

Three tools that existed but were refused in Slack are permitted to the owner in the private
channel:

| Tool | Reads | From |
|---|---|---|
| `steads_status` | The figures listed below for the four games | Havenstead intake `:8104`, Moorstead `:8095`, Saltstead `:8097`, Marsstead `:8098` |
| `moorstead_status` | How many sessions are live on Moorstead now, by room. No names | Moorstead `:8095` |
| `spire_health` | Whether the Spire venue and voice signal answer | `SPIRE_VENUE_URL` if set, otherwise `spire.lquorum.blog`; the voice signal host |

## What `steads_status` reports

| Game | Figures | Note |
|---|---|---|
| Havenstead | Visited today, started play | Added in this release. It had no tool. No "on now" or all-time figure exists |
| Moorstead | Visited today, played today, browsers ever; live sessions now | The live-session count covers every device, the owner's included. The ledger does not classify live sessions, and the line says so |
| Saltstead | Visited today, started play, players ever | No "on now" figure exists |
| Marsstead | On now, visited today; VESPER up, DOWN or state unknown | No play figure is reported |

Except where the line says otherwise, every figure is the ledger's external class: owner devices
and known bots are excluded. Before this release Moorstead's and Saltstead's figures were totals
across all classes; Saltstead's "players ever" was 187 on 27 September 2026, of which 38 were
external.

- **A figure is printed only if the ledger supplied it as a whole number, zero or more.** A game
  that answers without its figures is reported as "figures unavailable". A game that does not
  answer, or answers with an error, with something that is not JSON, or with JSON that is `null`,
  `0`, `false` or an empty string, is reported as down (v40: corrected).
  Neither is reported as zero.
- **The tool's output states the UTC time the figures were read.** Clint's reply is written by
  the model, and nothing forces it to repeat that time.

## Text chosen by other people

Players choose their names, and the ledger passes on the places and rooms their sessions report.
The model that reads a tool's output in the private channel holds the owner's tools, including
Drive and Calendar reads and web requests. So in Slack `moorstead_status` returns no text that a
player chose:

- It returns a count of live sessions for each of `moor`, `dale`, `crag`, `tarn` and `bairns`, and
  `solo` for a session that reports no room. A session reporting any other room is counted as
  `other`. A room with no session is left out (v40: corrected).
- In a Slack scope, and for a caller with no scope, names, places, days, player IDs and addresses
  are never returned, shortened or otherwise (v40: before v40 a caller with no scope got names).
- If the ledger cannot be read, the reply is a fixed sentence. Nothing from the ledger's error is
  repeated.
- The reply is a few hundred characters at most however many are online, so none of it is cut off.

Names remain on the Moorstead dashboard. A scope on a transport other than Slack gets the original
reply, with names. WhatsApp is retired. Whether any other process calls the tool is not verified.

`spire_health` shows the venue's version only if it is digits and dots. A successful reply without
such a version is reported as "answered without a version, so its state is unknown", not as up.

`steads_status` returns numbers and fixed words only.

## Who can use them

| Audience | Permitted |
|---|---|
| Owner in the private channel, open policy | Yes |
| Anyone in the public channel, including the owner | No |
| The peer lane | No |
| Owner under a read-only or web-only scope, or a policy other than open | No |
| Anyone else | No |

The refusal outside the private channel is explicit in `permitsTool`; it does not depend on the
channel being read-only. The same check runs when tools are chosen for a request and again when
a tool is executed, wherever a scope exists. For a caller with no scope the dispatcher makes no
check; that pre-dates this release. Some tools check the scope themselves and refuse without
one. These three do not, and `moorstead_status` then returns counts (v40: corrected).

The tools are offered whatever category the router gives the request, because a question about
the games can be classified as conversation, system or general knowledge. One exception: a
message beginning "Merlin" selects the Moorstead-only mode, in which `moorstead_status` is the
only one of the three offered, and the mode's prompt mentions actions that Slack does not permit.

## What did not change

- No tool that acts was enabled: minting and revoking codes, muting, broadcasts, kicks, bairns
  status and controls, service operations, the code tool, Spire feedback and Spire presence all
  remain refused in Slack.
- The public channel's and the lane's permitted tools are unchanged.
- The peer lane is included in this release's code and remains off unless both of its settings
  are present. See `clint-peer-lane.md`.

## Other effects

- On transports other than Slack, the owner is now offered these three tools in every category,
  not only when the request is classified as planning. WhatsApp is retired, so this has no
  present effect. Non-owners and venue speakers are offered nothing new.
- `src/tools/moorstead.js` and the source-size ceilings are unchanged. The Slack reply lives in a
  new module, `src/tools/moorstead-presence.js`, which the tool handler now imports from.

## Known limits

- `moorstead_status` cannot answer "is Henry playing" or "where is X" in Slack. Its description
  tells Clint to say so and point to the dashboard.
- The permission names the scope Slack issues for the private channel. It does not itself check
  the channel ID; the Slack adapter does that before a scope is issued.
- The Slack prompt does not carry the long description of the games that the retired WhatsApp
  prompt did. Clint relies on the tool descriptions to know when to call them. Whether it does
  so reliably is a question for the trial, not something the tests establish.
- `spire_health` makes two requests to public hosts. It sends no key.
- `src/tools/spire.js` reads two settings from the process environment directly. That pre-dates
  this release.

## Trial

1. In the private channel: "Clint, how are the steads?" Pass: a reply covering all four games,
   and the journal shows `queued` then `reply_sent`. Note whether the reply gives the time.
2. "Clint, who is on Moorstead?" Pass: a reply giving counts by room, no names, and saying names
   are on the dashboard.
3. "Clint, is the Spire up?" Pass: a reply from `spire_health`.
4. In the public channel, the owner asks the first question. Pass: Clint does not call the tool
   and says the figures are unavailable there.
5. "Clint, mint a Moorstead code." Pass: Clint says it cannot do that here. No code is minted.
