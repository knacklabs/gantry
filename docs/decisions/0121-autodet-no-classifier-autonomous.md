---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-11
stories: [AUTODET-1]
---

# Autonomous Runs Decide Permissions Deterministically — Classifier Is Interactive-Only

## Context

On a scheduled (jobId-bearing) run, a tool call that misses the host's
reviewed rules fell through to the auto-mode classifier. The classifier's
"allow" rescued the call non-deterministically (`decidedBy: auto_classifier` —
45 RunCommand survivals in production logs); its "ask" is unanswerable on an
autonomous run, so the runtime cancelled it — a terminal denial (0115) that
paused the job with a card. The same granted `send_message` call was cancelled
at 08:53 and allowed at 10:01 on 2026-08-11 (KnackLabs Lead Maintenance).
A permission decision that depends on a model's judgment call cannot be part
of an unattended pipeline whose "ask" has no listener. CLIRUN-1 (0120) removed
this non-determinism for local-CLI capabilities; this decision removes it for
every tool.

## Decision

An autonomous run's permission decision is a pure function of its declared
grants. The host decision tail never consults the classifier for a
jobId-bearing request: a reviewed-rule match allows; a miss is a deterministic
terminal denial (typed provenance `deterministic_rails`, per 0107) routed to
the existing pause + one grantable card (SCHED-6/CAPRULE-1). Granting from the
card resumes the job and is permanent: granted implies matched, forever. The
classifier remains in the interactive path only, where a human can answer its
ask. The autonomy predicate is the host-verified run-registry jobId, never a
worker-supplied field.

## Consequences

- Same job, same call, same decision, every run. The pause-on-a-granted-tool
  class is structurally closed.
- Calls the classifier used to luckily allow now deny until declared: at most
  one grantable card per genuinely missing tool, then silence. Trade accepted
  explicitly by Ravi (chat, 2026-08-11 — "Remove entirely").
- Rejected alternative (do NOT re-propose): classifier as allow-only rescue on
  autonomous runs — keeps ask-terminal safe but preserves
  same-call-different-day outcomes; rejected by Ravi 2026-08-11.
- Reconciled with 0043: the classifier's risk-only charter governs what it
  judges; this decision narrows where it runs.
- send_message is own-conversation-only by contract (no destination
  parameter); a destination-bearing send tool is a separate future decision,
  not covered here.
