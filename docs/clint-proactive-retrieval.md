# Clint research and recall — v23 candidate

This increment restores useful work independent of WhatsApp. Deployment is pending;
source and model-output evidence are kept in the workspace evidence directory.

## Retrieval

The immutable archive remains the source of truth. Knowledge search merges lexical
BM25 and full 4,096-dimensional Qwen3-Embedding-8B cosine rankings using reciprocal
rank fusion (constant 60). Each ranking counts a source record once; repeated chunks
cannot accumulate votes. The model receives original attributed records, never
embedding-generated summaries. Dense search runs on a CPU worker and does not load
another model. The already resident embedding server is checked against its measured
model basename, build and context before use. An absent or incompatible index/service
leaves lexical retrieval available and reports the reason.

`knowledge_status` and each search report dense coverage. A partial backfill does not
mean the remaining archive is absent: lexical search still covers it. The resumable
builder writes a separate derived SQLite file, binds it to the archive's binary hash,
checks resumed rows and commits each chunk atomically. It checks actual token counts
and splits overlong passages before embedding; all source characters are retained.
The production CLI runs only while Flash reports idle and host available memory is
at least 10 GiB. Use a bounded CPU client, not another GPU/model process.

Long records open at the matched region and use versioned pages of at most three indexed parts. Every page is marked
partial with unread coverage and exact forward/backward requests. Continuations reject
changed snapshots or source parts. All 433 formerly blocked long records reconstructed
exactly in a source-only test, through 1,148 pages. The largest needs 17 reads: this is
accessibility evidence, not proof of single-attempt comprehension within the model's
context and tool-round limits. Partial pages never enter the whole-record failure
fallback.

## Proactive work

The Slack process owns its scheduler and a separate private durable job database.
After 03:45 Europe/London it selects up to two practical public research questions
from recent authentic owner messages, searches and reads sources, and reviews those
messages for useful unresolved connections. Fetched-source outcomes retain dates,
hashes, limitations and unread coverage. Reflections are explicitly unverified
hypotheses with source IDs. They do not update factual memory, weights or code.

After 07:00, a morning briefing presents model-selected whole source paragraphs,
copied exactly by code, with a fresh primary Google Calendar read for the next 24
hours. Free-form research drafts are retained separately and never rewritten into
the delivered briefing. Tentative events and source limitations remain explicit.
This first version reads one page of the
primary calendar; it cannot establish complete diary coverage or free time. The
briefing goes only to James's configured private channel. `proactive_status` and
`proactive_report` expose actual job outcomes and saved reports.

Jobs start after 15 minutes without input; new input cancels background inference.
Network reads may finish their existing bounded request. Background model calls are
serialized and capped at 120 seconds/1,200 output tokens each; a whole job has an
eight-minute deadline. Failed generation gets at most three attempts; foreground
cancellation gives the attempt back. Successful jobs survive restart. Uncertain
Slack delivery is never automatically repeated. Scope is checked before work and
again before delivery. `SLACK_PROACTIVE_ENABLED=false` disables starting new jobs.

The scheduler does not send messages to other people, create calendar events,
purchase anything, train weights or deploy self-authored code. Those are separate
capabilities requiring appropriate permissions and workflows. Existing hypotheses
and isolated code-proposal mechanisms remain review material.

## Verification and rollout

Independent read tools can run concurrently, at most three at a time, only in the
authorised private owner read-only Slack scope. Results retain requested order.
Multiple dense searches or document extractions remain sequential. This is tool I/O
parallelism; inference slots are a separate measured hardware decision.

The initial free-form briefing trial failed grounding despite passing narrow
checks. Its verdict remains failed. The revised paragraph-selection mechanism passed
seven independently frozen criteria on a fresh actual Flash trial involving a
different topic, late qualifications, a failed source and tentative diary entries.
That establishes this bounded briefing mechanism, not general synthesis accuracy.

Canonical verification is `npm run verify`. Focused tests exercise source aliasing,
stale vectors, scope boundaries, partial reads, foreground interruption, invalid
model output, restart and uncertain delivery. A fresh actual Flash trial uses only
synthetic tools and sources; its output is reviewed separately from structural tests.
The private archive is never a semantic gold standard simply because indexing passes.

Deploy through the existing source staging and verified Flash stop/recovery/install/
start path. Publish a checked sidecar only while the controller is stopped, with the
archive's ownership and read-only binds. Rollback restores the prior code; the prior
release ignores the additional derived index and job database. Never alter the
original knowledge snapshot in place.
