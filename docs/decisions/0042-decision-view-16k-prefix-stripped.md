---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-23
---

# Decision View 16K Prefix Stripped

## Context
The permission decision layers (deterministic rails, effect-key cache, classifier,
reviewed-rule matcher) consumed the 500-char-truncated `toolInput`, while the host
injects a ~740-char env prefix into every shell command. The real command was
therefore discarded before any decision, and everything was treated as "incomplete
input → ask" (F1 root cause; live evidence: 0/38 saved rules matched, 165 human
asks). We need the decision path to see the real command without bloating the
mobile display/receipt/log copy.

## Decision
Strip the host env-prefix (`stripHostInjectedEnvPrefix`) from shell command fields
at the IPC-parse layer before sanitizing, and route the DECISION consumers
(rails + effect-key) to the 16k `classifierToolInput` view. `toolInput` stays the
500-char display-only copy. `inputIsIncomplete` is refined to fire only on genuine
absence or truncation of the 16k command string — sensitive-key redaction and
500-char display truncation are not "incomplete".

## Consequences
Rejected: raising `toolInput` to 16k everywhere — it bloats receipts/logs and the
mobile prompt. The 500-char display copy is retained for receipts/logs. Execution
is unaffected (the runner still runs the real prefixed command); stripping is for
decision/display/cache only. A genuinely long shell command (>16k after strip)
still degrades to ASK, which is safe.
