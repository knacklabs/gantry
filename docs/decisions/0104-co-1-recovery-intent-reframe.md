---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-03
stories: [CO-1]
---

# CO-1 Recovery-Intent Reframe

## Context

Audit item B1 (coordination-representation-audit-2026-07-18) prescribed
"recovery intent as columns with compare-and-set transitions". Verification
against main @ 69ac5b716 found the recovery-intent state machine has zero
production callers: nothing ever writes a non-null intent, the claim guard is
always false, and the audit's headline failure mode (parked job becomes
re-claimable) cannot fire. Meanwhile three sibling fields in the same
`target_json` blob ARE live and lost-update-prone: `consecutiveFailures`
(drives auto-pause), `pauseReason`, and `setupState` (incl. the notify-dedup
fingerprint).

## Decision

CO-1 is reframed (Ravi, 2026-08-03, in chat): delete the dead recovery-intent
machinery outright — service, parser, domain type, claim guard, visibility
metadata, null-clear writes — and promote the LIVE coordination fields to
dedicated jobs columns written only by targeted, race-safe statements (in-DB
counter arithmetic, fingerprint-guarded `jsonb_set` for notify-dedup, plain
column sets for pause/clears). Residual intents written by the 2026-05-25..bdf86d2f0
era (the flow production briefly ran before it was deleted) are inert residue;
the cutover migration logs and drops them — a stale 'running' intent only ever
blocked claims via the guard being retired, so dropping it un-sticks the job.
The live deployment was verified to hold zero residual intents.

## Consequences

- The lost-update class on live job coordination state is closed structurally;
  the never-fireable guard code is gone rather than hardened.
- If job recovery-intent tracking is ever genuinely needed, it must be designed
  and wired as a new story against real callers — this decision pins that the
  old unwired machine is not the starting point.
- Audit B1 is satisfied in spirit (no JSON-blob coordination state, CAS-style
  transitions, concurrency test) and superseded in letter for the dead half.
