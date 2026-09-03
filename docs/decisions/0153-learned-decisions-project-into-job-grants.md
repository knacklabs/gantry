---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-02
stories: [ASKFLOOR-1]
---

# Learned human permission decisions are a declared-grant input for scheduled jobs (amends 0121)

## Context
Decision 0121's contract is that a scheduled (host-verified, jobId-bearing) run's permission outcome is a **pure function of its declared grants** — no classifier, no conversational memory, so a job that meets an undeclared need pauses on a card rather than guessing. ASKFLOOR-1 adds a human-decision memory for the interactive auto lane (decision 0154): a remembered **[Allow]** stores exact effect hash + rails version + scope. The owner ruled on 2026-09-02 that scheduled jobs must benefit from those decisions ("jobs consult learned decisions as grants") and, in the plan-gate round, that the projection is **live and revocable on every job permission request** rather than materialized into job-owned grants. Live evidence: 975 of 976 decisions in 48 hours were allow_once and the KnackLabs job re-asked per run for shapes the owner had already allowed in chat.

## Decision
The set of declared grants a job's permission outcome is a pure function of is widened by exactly one deterministic input: the active `human_decision` records of the job's owner for that app/agent WITH `outcome = allow` (exact effect hash or matching scope, same rails version, not revoked); remembered No records are never projected — a job's undeclared need still cards rather than silently failing (pinned by a non-projection test). The projection is computed host-side at each job permission request (the IPC autonomous decision path and the inline scheduled loop) — never by the classifier, which remains excluded from autonomous runs — and a "Forget this" (`revoked_at`) or a rails-version bump takes effect at the next request. Once-only decisions are never projected. The projection is scoped by the acting person (decision 0118): a DM-created job consults only the records of its host-derived `personId`; a job whose acting person cannot be resolved gets NO projection (fail closed). Superseded clauses of 0121, explicitly: "no conversational memory" — the human-decision memory is host-owned durable state, not conversational memory, and is the one exception; "permanent" and "the same decision every run" — a job's outcome is now stable BETWEEN changes to the learned set, and changes only when the owner remembers, forgets, or the rails version bumps, each of which is visible in `/permissions`. 0121's invariant is restated, not broken: the outcome is still a pure function of (declared grants ∪ projected learned grants), both host-owned facts.

## Consequences
- Fewer job cards: a shape the owner remembered in chat stops asking in jobs without a separate job-side grant; `/permissions` rows show "also used by job <name>" so the owner sees the reach of a remembered decision.
- Revocation is immediate and central (one row), because nothing is copied into job definitions; the price is a memory lookup on every job permission request (indexed by effect hash / scope key).
- Scope discipline carries over: a "kind of action, anywhere" read scope unblocks read-only job commands broadly (intended); writes and destructive shapes only ever project as exact (path-scoped for file writes per the owner's ruling).
- The invariance suite gains an autonomous projection matrix: exact/kind/place match allows; near-miss (different effect, scope, or rails version) still cards; revoked re-cards; ask mode and auto_strict never consult the memory; inline-scheduled expectations that currently assume classifier consultation are updated to the projection.
- Doors closed: jobs never write to the memory; no classifier on autonomous runs; no widening of the shared deterministic rails.
