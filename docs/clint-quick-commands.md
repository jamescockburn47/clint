# Explicit Slack diagnostics

The owner can send `clint help` or `clint status` as a complete message in the
configured private, unshared James-and-Clint channel under open policy.
Case and surrounding whitespace do not matter. Quotes, extra instructions and
compound requests are ordinary model input. These are message commands, not Slack
slash commands; they require no app registration or new scopes.

`clint help` renders the core's current available tool schemas after the same tool
permission predicate. It distinguishes offered operations from successful connection
checks or completed source reads. Tools added without a human description are listed
by name instead of having a capability inferred from that name.

`clint status` calls the existing bounded runtime observer using the configured Slack
model endpoint. It reports observation times, configured versus observed model,
context/slots, CPU, Linux-managed RAM and GPU allocations, and release identity.
Null values stay unobserved; failed later reads do not reuse an earlier snapshot.
The existing reader does not measure installed physical RAM, weight checksums or
model quality. GTT is not added to host RAM or GPU memory. Nothing generates tokens,
loads models, changes configuration or checks unrelated accounts.

The adapter issues the same request authority before dispatch. Commands require
owner identity, Slack group audience, private open policy, local inference mode and
read-only authority. Input/output topic filters, the canary filter and deterministic
credential screening remain active. The inbox worker still validates actual channel
membership before observation and again before delivery, persists and deduplicates
replies, and uses plain-text blocks. A queued status reply remains labelled with its
original observation time if Slack delivery is delayed.

This is an explicit command feature, not an intent classifier or a successful small
model gate. Natural conversation, teaching, model settings and general factual
accuracy are unchanged. It does not supersede any failed gate/teaching/detector trial.

Verification: `npm run verify`; focused checks use
`node --import tsx --test test/slack-quick-commands.test.js`. Deployment requires
fresh independent review and the existing canonical stop/recovery/install/start path,
then installed authorization/observation/isolated-delivery proof. No real Slack test
post is required or authorized by the test command.
