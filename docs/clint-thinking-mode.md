# Thinking and the selected Flash runtime

17 September 2026: owner-authorized return from benchmarking to normal Slack use.
Use `think: <request>`, `clint think: <request>` or `use thinking mode: <request>`.
Only the authenticated current message selects the mode. It applies to all model
calls for that request; it does not persist into the next ordinary message.
Ordinary Slack requests explicitly disable thinking. Scheduled research, planning,
reflection and synthesis automatically enable it; foreground input still cancels
background work. Internal reasoning is not sent to Slack.

The tested serving profile is Engram Q4_K_XL plus Q4_K_M MTP, draft depth 4,
minimum probability 0.75, MTP plus ngram-mod, q8_0 K/V, one 131072-token slot,
batch 4096 / microbatch 2048, CPU boost disabled while Flash runs. Further tuning
is paused. The same 4096-dimensional embedding endpoint runs on CPU.

Thinking calls receive 32768 total generation tokens; the server limits reasoning
to 24576, leaving 8192 for the answer. Ordinary calls receive 8192 generation
tokens. Deadlines are 30 minutes thinking / 15 minutes ordinary; the entire
overnight research job has 90 minutes. These are finite operational bounds, not
guarantees that every problem finishes. Token-limit responses remain visibly
incomplete, never silently treated as completed answers.

Each Flash call counts its rendered prompt and tool schemas using the serving
tokenizer. Inputs above 97280 tokens are rejected with a notice, reserving 32768
tokens plus a 1024-token margin. Recent history grows from 18000 to 48000
characters, preserving whole exchanges and stating how many older exchanges were
omitted. Retrieval remains available for older records. Completed Slack answers
up to 32000 characters are transported intact in plain-text blocks.

Canonical app verification: `npm run verify`. Deployment and recovery evidence:
`../../evidence/clint-restore-20260917/`. No benchmark or firmware trial is resumed.
