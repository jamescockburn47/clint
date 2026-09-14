# Owner teaching in private Slack

**Experimental and disconnected from the live entry point.** The frozen v10 Flash screen
failed overall: a software choice invented supporting facts and an illustrative style sample
leaked a drinks arrangement into a new event. Persistence and retirement worked, but do not
establish safe behavioral transfer. See ../../evidence/independent-teaching-transfer-review-20260914.md.
The following documents the candidate interface, not a live capability.

Candidate v10 adds source-linked guidance, not model weight training. Only James's exact
configured private, unshared channel with James and Clint can save or retrieve this state.
Membership is checked before work and again before delivery. Current request instructions
take precedence for that request; stored contradictions remain separate and inspectable.

- `teach: ...` saves a scoped instruction verbatim, including exceptions.
- `correct: ...` saves an owner-supplied correction, not an independently verified fact.
- `example: ...` saves an illustrative example, not biographical evidence.
- `teachings` lists active records, two per page; `teachings 2` continues.
- `teaching T...` inspects an ID, including a retired record.
- `unlearn: T...` retires an ID from future active guidance, preserving its audit record.

Acknowledgements follow SQLite commit. Source event replay does not duplicate a record.
Literal model-control tags are rejected before saving because the transport cannot safely
echo them. Each command accepts at most 4,000 characters; divide distinct instructions,
but keep each scope and exception together.

Ordinary messages and feedback are stored as attributed episodes with their preceding
exchange. Relevant and recent episodes may inform later responses, without automatically
turning one-off requests, jokes or assistant statements into permanent rules or facts.
Retrieval currently combines FTS keyword matching and recent records within a 12,000
character budget. Whole records are selected; omitted candidates are reported to the model.
This is bounded recall, not guaranteed retrieval of every applicable past instruction.

Retirement deliberately excludes all earlier ordinary context, including unrelated earlier
feedback, to prevent old assistant answers from reintroducing the retired instruction.
Unrelated explicit active teachings remain available. The cutoff includes processing time
and all already known messages, so a late Slack event cannot leave a newer cached answer
using the old instruction. Cutoffs are immutable on repeated retirement. Old raw records
remain inspectable for audit; this is not deletion of source data.

State lives in `teachings.sqlite` beside `slack.sqlite`, protected by the same service UID
and private directory. It is separate from the read-only knowledge archive. Prototype
databases were never deployed; initial installation requires no existing teaching database.
Rolling app code back preserves that database but disables its use on earlier versions.

Validation: `npm run verify` includes authority, crash/replay, uncertain delivery, policy
changes, delayed retirement and source-attribution checks. The separately frozen synthetic
actual-Flash transfer screen tests future answers after restart. Passing this small screen
does not establish deep learning, broad personality mirroring or factual reliability.
