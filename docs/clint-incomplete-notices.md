# Honest incomplete-attempt notices

The read-only owner Slack path returns a fixed notice when an attempt ends without
a usable answer: provider loss after a tool, tool-round exhaustion, an empty tool step,
token exhaustion, malformed/blank/control-only content, or an oversized reply.
Pending tool-call prose and truncated answers are not described as completed work.

The notice uses the normal persisted Slack response and current delivery authorization.
An ordinary delivery retry reuses it without repeating model generation or tool reads.
Initial provider unavailability retains the existing outage handling. Other transports
and write-capable scopes retain their prior behavior. Normal usable answers still pass
through the existing critique and conversation output policy.

There is no extra finalizer request, source-reader tool, prompt replacement, reasoning
setting, sampler change or deadline increase in this release. The existing five-round
tool loop and model requests remain bounded as before. Notices state that work is
unfinished; they do not make research or factual recall more accurate.

Earlier source-reader and final-answer candidates were not deployed. The v16 final
evidence diagnostic failed all three cases; one v17 inert-record revision also failed
all three. Exact records did not improve missing-evidence or dispute handling enough
to pass. Their source, fixtures, outputs and independent verdicts remain in evidence;
experimental implementation/test files are preserved outside the active app.

Run `npm run verify`. Focused regressions cover call/round limits, no replay, malformed
replies, scope restrictions, ordinary output filtering, persisted notices and uncertain
delivery. These tests establish failure handling, not general model accuracy.
