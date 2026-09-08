---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-08
stories: [ASKFLOOR-1]
supersedes: 0121-autodet-no-classifier-autonomous
---

# Jobs use the chat permission ladder — the classifier judges autonomous runs

## Context

0121 (2026-08-11) made an autonomous run's permission decision a pure function
of its declared grants: the classifier never ran for a jobId-bearing request,
and a miss was a deterministic terminal denial routed to one grantable card.
The trade accepted then was "calls the classifier used to allow now deny until
declared". In practice that trade bugs the owner: every small call a job makes
for the first time (a plain `curl`, a read-only listing) raises a card and
blocks the job on a human, while the same call in chat auto mode is judged by
the classifier and only escalates when the classifier is unsure. ASKFLOOR-1
has since given the classifier a real first-ask floor (T1/T2) and a
person-scoped decision memory (T3a–T3c) that jobs project (T4, 0153), so the
inputs that made the 2026-08-11 outcomes flip-flop are now deterministic
where they can be, and the remaining judgment is the same judgment chat trusts.

## Decision

A job's permission request walks the SAME ladder as an interactive auto-mode
turn: deterministic rails → the owner's remembered decisions (projected, 0153)
→ the classifier → a card ONLY when the classifier escalates (ask). The
classifier's allow and deny are honoured on jobs exactly as in chat, with
their existing provenance; its ask lands on the existing pause-and-ask card
(SCHED-6/CAPRULE-1/JOBPERM), and granting from that card stays permanent.
The owner is never asked for a call the classifier would have allowed.
This supersedes 0121 in full; its rejected-alternative ban is lifted.
Confirmed by Ravi in chat, 2026-09-08 ("Similar to chat, user is needed only
when classifier escalates it. Not for all of them … I don't want user to be
bugged for all small grants too").

## Consequences

- Jobs stop blocking on first-time small calls; the human sees a card only on
  a classifier escalation, a hard rail, or a missing route.
- The same-call-different-day variance 0121 removed can return for calls the
  classifier judges near its threshold; the mitigation is the memory ladder
  (a remembered Allow projects deterministically ahead of the classifier) and
  the T1/T2 first-ask floor, not a classifier ban.
- 0043 (risk-only charter) governs what the classifier judges; this decision
  widens where it runs to autonomous lanes. 0153 is unchanged: jobs consume
  projections and never write memory. The autonomy predicate stays the
  host-verified jobId.
- Work implied: ASKFLOOR-1-T4 reinstates the classifier on the worker (IPC)
  job lane and keeps it on the inline scheduled lane, ordered after the
  projection; the 0121 architecture text and tests pinning "never runs for a
  job" are rewritten to pin the ladder order instead.
