---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-16
stories: [CAPSAFE-1]
---

# Local-CLI terminal wildcard is a reviewed argv remainder

## Context

Structured local-CLI execution interprets every `*` in a reviewed command template
as exactly one non-flag argv entry, and requires the invocation argv to have the
same length as the template (arity-exact), rejecting any flag token
(`structured-local-cli-invocation.ts`, the arity-exact/no-flag clauses). The
scoped RunCommand rule matcher already interprets a final standalone `*` as "the
remaining argv" (`tool-rule-matcher.ts:543`). The same template therefore means
two different things on the two authorization paths.

The divergence turns ordinary flags (e.g. `gog … --values-json`) and additional
operands into repeated template amendments. Once overlapping templates accumulate,
the amendment compiler counts multiple literal-prefix candidates and returns an
administrator instruction instead of a proposal (`capability-template-compiler.ts:49`),
so the recovery path fails closed. Net effect: an agent that already HOLDS a
capability cannot perform a simple, safe operation, and the whole widening
apparatus exists only to compensate for the over-strict base match. The exact-arity
behavior is locked by a regression test, so changing it is a decision, not a bug fix.

## Decision

For `local_cli` command templates only:

- The executable and the literal operation prefix match exactly (the hard boundary).
- A non-terminal standalone `*` matches exactly one non-flag argv entry.
- A final standalone `*` matches zero or more remaining argv entries, including flags
  and flag values (the same "remaining argv" semantics the RunCommand matcher already
  uses).
- A mixed-token glob remains confined to a single argv entry.
- Shell control syntax, redirection, environment assignments, and any executable
  change remain invalid.
- There is ONE shared matcher implementation used by dry-run authorization,
  execution, and the compiler's coverage checks. No legacy exact-arity mode is kept.

The amendment compiler first checks the observation against current authority; an
already-covered call produces no amendment. For a genuine mismatch, multiple eligible
source templates may produce a proposal only when their canonical proposal sets are
identical; divergent results, mixed-glob candidates, or any ineligible competing
candidate fall back to the administrator instruction. Widening classification becomes
semantic (adding the first terminal remainder wildcard is an expanded-authority
warning), not slot-count based.

## Consequences

Amends the arity-exact clauses in Decisions 0120 and 0122 and the exactly-one-template
clause in Decision 0125. Existing templates change semantics cleanly; no compatibility
format or fallback matcher is retained (per 0003 no-backcompat). A held capability's
prefix now authorizes any invocation under it — flags included — so the common case
needs no runtime widening, no card, and no classifier. The security boundary shifts to
the executable + literal prefix: within a granted prefix, argument content is
unbounded (the deliberate Claude-Code-style tradeoff for a feature that works).
Executable identity, capability selection, person scope, sandboxing, egress, redaction,
and approval provenance are unchanged.
