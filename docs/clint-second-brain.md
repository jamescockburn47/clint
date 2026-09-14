# EVO second brain decision — 13 September 2026

## Recommendation and present status

Retain Clint as the application and use the existing local Qwen service for a
private, source-grounded second brain. Build and evaluate retrieval and a behavioral
profile before deciding whether a LoRA/QLoRA adapter buys a meaningful improvement.
No second-brain deployment, training run, service reconfiguration, or cloud spend
was performed in this assessment.

The intended implementation is Tier A because it handles private/client memory.
The critical journey is an authenticated owner query, scope-limited retrieval,
and an answer accurately attributed to dated source records. Credible failures are
private-memory disclosure to a Slack channel and attributing someone else's words
or an assistant's invention to James. Deterministic scope enforcement, regression
fixtures, independent review and an actual owner-entry probe are required for release.
This decision document and synthetic diagnostics are supporting, reversible work.

## Observed host evidence

Read-only SSH and HTTP inspection on 13 September found:

- Gateway at loopback port 11435: `qwen3.8-27b` loaded.
- Main process: `/models/Qwen3.8-27B-Q8_0.gguf`, llama.cpp server,
  configured context 524288 and parallel slots 4. This does not establish that
  every request receives 524288 tokens or that useful recall spans that context.
- Embeddings: `/home/james/models/Qwen3-Embedding-8B-Q8_0.gguf`, port 8083.
- GPU memory: 73/96 GiB occupied; system available memory: 18 GiB.
- Home filesystem: approximately 90 GiB available; no managed heavy jobs running.

Private evidence lives outside the Git worktree at `../../evidence/`:
`second-brain-host.json`, `second-brain-qwen-probe.json`, and
`second-brain-qwen-attribution.json`.

Three small synthetic checks supplied evidence directly in the prompt. The dated
correction and missing-evidence checks passed. The original attribution check failed
JSON parsing. One diagnostic rerun increased the token limit from 200 to 512 and
retained the full synthetic response: Qwen correctly answered "No" and cited S2,
but wrapped JSON in a Markdown fence despite `response_format: json_object`.
It ended normally after 27 tokens. That rerun does not support truncation as the
cause, nor does it recover the unretained first response. The current format
constraint is not reliably enforced. Do not describe this as a clean 3/3 pass.
Observed wall times were approximately 3–10 seconds for these tiny requests.
Retrieval quality, longer reasoning, access isolation and real archival recall
remain unevaluated.

## Application shape

1. Preserve immutable archives with source IDs, timestamps, speaker attribution,
   project/privacy scope and explicit distinctions between human and assistant text.
2. Build hybrid lexical/vector retrieval using the existing embedding service.
   Filter scope before retrieval; pass only relevant records to Qwen with citations.
3. Keep current decisions, tasks and corrections in explicit structured state.
   Conflicting and superseded positions remain attributed and dated.
4. Maintain a versioned behavioral profile: preferences, reasoning habits, and
   context-specific speech patterns. Separate observed conduct from desired assistant
   behavior. Do not infer authority from a personality profile.
5. Offer a private authenticated web interface over Tailscale as the owner surface.
   Slack in LQ can become a scoped capture/query interface. A shared channel must
   never implicitly gain access to the owner's private corpus.
6. Keep private queries local by construction. Existing Clint inference code has
   WhatsApp-specific instructions, broad working knowledge and a Claude fallback
   path; it must not be enabled unchanged for this use.
7. Make overnight reflection produce source-linked candidate connections, open
   questions and proposed actions. Hypotheses must not become autobiographical facts.

First acceptance experiment: a held-out set of real owner questions with manually
checked source answers, including same-topic different speakers, changed decisions,
quoted text, assistant inventions, no-answer questions and forbidden cross-scope
records. Compare baseline Qwen with and without retrieval/profile. A good-looking
answer with the wrong speaker, stale decision or inaccessible source fails.
Implement no dependent channel expansion until that mechanism passes.

## Fine-tuning decision

AMD's 20 July 2026 announcement explicitly includes Ryzen AI Max / Strix Halo in
Unsloth support. That establishes a plausible platform route, not verified support
for this exact Qwen3.8 checkpoint, training quantization, ROCm build or adapter export.

Use a compatible original training checkpoint and adapter training stack; the
running Q8 GGUF is an inference artifact and is not a checkpoint to train in place.
Prove a tiny adapter can train, save, load and reach the intended serving stack
before committing to corpus-scale preparation or a long run. All heavy EVO jobs
must use `evo-job` with measured admission and bounded resources. Current memory
occupancy makes concurrent training unproved; scheduling or changing model residency
requires an explicit operational decision. Do not stop existing services as setup.

The useful training target would be James's context-sensitive response behavior:
how he challenges a premise, revises a plan, explains something to a learner and
corrects an answer. Training ordinary exported user/assistant pairs with the
assistant response as target instead teaches the assistant's output style.
Prefer well-attributed James-authored responses and accepted rewrites. Keep whole
conversations/projects out of the training split for evaluation; remove duplicate
branches and quoted targets to reduce leakage. Full-corpus analysis remains the
goal even though a training pilot would use a curated subset.

Keep personal facts in retrievable memory, where updates, deletion and provenance
remain tractable. An adapter may improve habitual behavior; it does not establish
faithful personality replication, general intelligence or reliable factual recall.
Adopt one only if it wins a blind held-out comparison against retrieval plus profile
without degrading attribution, missing-evidence behavior or access/tool safeguards.

## Cost envelope, not a runtime quote

Runpod public rates checked 13 September 2026:

| Example GPU | Hourly rate | Assumed 4–12 hour experiment |
| --- | ---: | ---: |
| A100 PCIe 80 GB | US$1.59 | US$6.36–19.08 |
| H100 PCIe 80 GB | US$2.89 | US$11.56–34.68 |

Three experiments at those assumed durations span about US$19–104 in GPU rental.
These figures exclude storage, tax, preparation, evaluation and failed/repeated
runs. The duration is an illustrative budget assumption, not a benchmark of this
model or dataset. Cloud training would require a separate data-transfer decision.

Local rental cost is zero. At an assumed 200 W and £0.25/kWh, 24–72 hours consumes
£1.20–3.60 in electricity. Neither power, tariff nor training duration was measured.
Data selection and evaluation are likely to dominate the practical effort.

Sources checked 13 September 2026:

- [AMD: Train and Run Models on AMD GPUs with Unsloth, 20 July 2026](https://www.amd.com/en/developer/resources/technical-articles/2026/train-and-run-models-on-amd-gpus-with-unsloth.html)
- [Official Qwen3.8-27B checkpoint](https://huggingface.co/Qwen/Qwen3.8-27B)
- [Runpod pricing](https://www.runpod.io/pricing)
- [llama.cpp LoRA conversion implementation](https://github.com/ggml-org/llama.cpp/blob/master/convert_lora_to_gguf.py)
