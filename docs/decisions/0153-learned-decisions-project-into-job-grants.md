---
status: proposed
confirmed_by: ""
date: 2026-09-02
stories: [ASKFLOOR-1]
---

# Learned human permission decisions project into declared grants for scheduled jobs (amends 0121)

## Context
Decision 0121 established that autonomous (jobId-bearing, host-verified) runs never invoke the LLM classifier and that a job's permission outcome is a pure function of its declared grants — so a scheduled job that meets an undeclared need pauses on a card instead of guessing. ASKFLOOR-1 introduces a human-decision memory for the interactive auto lane: when the owner taps **[Allow]** (remembered) the outcome is stored by exact effect hash + rails version + chosen scope. The owner ruled on 2026-09-02 that scheduled jobs must benefit from those decisions ("jobs consult learned decisions as grants") — otherwise a command the owner already allowed in chat re-asks on every run of a job that uses it, which is the tapping the story exists to remove. The live evidence of 2026-09-02 (975 of 976 decisions allow_once; the KnackLabs job re-asking per run) is the forcing case.

## Decision
A learned human decision is projected into the autonomous lane as a **declared grant**: at job readiness / permission evaluation the runtime looks up the job's effect hash (+ rails version + scope) in the human-decision memory and, on an exact match that the owner allowed, treats it exactly as if the job had declared that grant. The lookup is deterministic and host-owned; the classifier is still never invoked for autonomous runs, denials remain terminal, and card recovery (CARDSIMPLE-2) is unchanged. 0121's clause "never consults human-decision memory" is amended to "consults it only as a projected declared grant". A once-only decision (**[Just this once]**) is never projected. A rails-version bump or an owner "Forget this" revokes the projection at the next lookup.

## Consequences
- Fewer job cards: any command shape the owner remembered in chat stops asking in jobs without a separate job-side grant; the `/permissions` view lists such projections with their scope so the owner can revoke them.
- 0121's invariant "no classifier on autonomous runs" is preserved; the invariance suite (ASKFLOOR-1 AC6) gains an explicit autonomous-projection case: an exact match allows, a near-miss (different args / scope / rails version) still pauses on a card, and a revoked record pauses again.
- Scope discipline: projections respect the remembered scope (exact action / kind of action / place). A "kind of action, anywhere" read scope therefore unblocks read-only job commands broadly — intended, since reads are the tapping the owner wants gone — while writes/destructive shapes only ever project as exact actions.
- Doors closed: no job-side learning (jobs never write to the memory), and no widening of the shared deterministic rails.
