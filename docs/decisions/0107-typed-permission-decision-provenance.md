---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-05
stories: [SCHED-1]
---

# Typed Permission-Decision Provenance

## Context

Job finalization pauses a recurring job when it sees a successful
allow_once decision not decided by a reviewed rule, interpreting it as "a
human approved this once and deliberately withheld future consent." But
automatic policy paths (auto_classifier, cached_classifier_verdict,
trusted_root_grant, birthright, deterministic read-only) also emit
mode allow_once — it describes the lifetime of the current invocation, not
human intent. The domain layer labels every allow_once user_temporary,
cementing the conflation. Result: healthy recurring jobs pause after runs in
which routine automatic decisions occurred — one of the two direct causes of
the lead-job loop. Separately, scheduler mutation tools sit in the grantable
medium-risk bucket and auto-approve in normal auto mode, contradicting
decision 0058's human-gating (decision 0065 explicitly did not change
auto-allow policy).

## Decision

Permission decisions carry typed provenance instead of overloading mode +
string decidedBy: a decision source (durable_rule | birthright |
deterministic_policy | auto_classifier | cached_classifier | trusted_root |
human_once | human_persistent) plus repeatable-for-future-runs semantics.
Recurring jobs pause ONLY on an explicit human one-time consent
(source human_once, not repeatable). Scheduler mutation and delete tools are
classified ask in normal auto mode (reads stay birthright); persistent
reviewed grants still apply, but the classifier never mints a first-time
automatic approval for a mutation of future unattended execution.

## Consequences

- Recurring jobs stay active across runs containing automatic allows —
  regression-tested per source.
- The permission-classifier tests that today REQUIRE auto-approval of
  scheduler mutations are corrected, not appeased.
- Existing reviewed persistent grants keep working (0065 preserved).
- Any code inferring intent from mode strings must migrate to the typed
  source — follow-through enforced by removing the old inference path.
