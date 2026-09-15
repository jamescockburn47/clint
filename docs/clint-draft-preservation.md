# Owner Slack draft preservation

The private owner, local-only, read-only Slack path does not use the legacy
draft-only style rewrite. That rewrite receives no original question or tool
evidence and is instructed to condense, add novelty and default to replacement.
It is not a source verifier. Removing it prevents a second unsourced model pass
from changing an otherwise completed answer's facts, citations and qualifications.

Both critique selection and direct critique invocation enforce the same issued
conversation scope. Other transports, audiences and policies retain their existing
behavior. Audience authorization, deterministic output filtering, terminal failure
notices and Slack delivery validation still apply. The original draft may itself
be wrong; this change does not certify factual accuracy or activate teaching.

Regression checks use a completed, fact-changing rewrite as a negative control,
then prove exact draft preservation and zero critique calls in protected scope.
The actual core/tool loop and real quality module are exercised together; blocked
topics and canary output still fail. Canonical verification is `npm run verify`.
