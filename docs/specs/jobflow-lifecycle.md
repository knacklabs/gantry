---
slug: jobflow-lifecycle
title: JOBFLOW - seamless scheduled-job lifecycle
status: confirmed
saved: 2026-08-12T05:30:00+00:00
---

# JOBFLOW — Seamless Scheduled-Job Lifecycle

Derived from: the JOBFLOW epic plan (15 adversarial validation passes,
2026-08-12); supersedes-in-part decisions 0115 / 0117 / 0122 / 0123 via the
S1 amendments the plan enumerates.

## Why

Scheduled jobs stall silently. The KnackLabs incident chain showed seven
stacked failure layers; the headline defect is that the owner NEVER received
a working Allow/Deny card in production: failed card delivery is recorded as
a human denial, the durable prompt row is resolved by a send failure, and
denial evidence travels as parseable marker strings. Job prompts compensate
by carrying system mechanics ("never probe tools", "stop on failure")
instead of business logic.

## Behaviour

1. TYPED DENIALS. Every terminal autonomous tool denial in scope (0115's
   three Anthropic guard exclusions remain non-terminal) is recorded as a
   durable, idempotent, ordered runtime event carrying a semantic
   denial_kind (permission_denied | rule_denied |
   capability_template_mismatch) and provenance. Status, visibility, and
   finalization read the typed record — never marker strings.

2. ACTIONABLE PAUSE. A setup pause produces exactly one actionable card per
   blocker via the outbound-delivery subsystem: bounded retries (cap 4),
   crash-safe atomic preparation, and a DEFINED outcome for every path —
   delivered, ambiguous (card may exist; if it arrived its buttons work),
   exhausted (retry via resume, same prompt, new delivery generation),
   expired (fresh prompt on resume), cancelled. Delivery failure is never
   recorded as a human denial, on any channel (Telegram, Slack, Teams,
   Discord). A human's in-flight claim is never clobbered; approvals stay
   available from the pending list whenever a decision is still meaningful.

3. HOST-FILED FIXES. A recognized capability template mismatch produces a
   host-compiled fix proposal (host-only authorship; the agent-authored
   amendment path is removed). Owner approval applies the proposed
   templates (base + flagged variants, full pinned paths) and DURABLY
   resumes affected jobs (closes D-0057). Anything unrecognized falls to a
   plain-language instruction card.

4. BUSINESS-ONLY PROMPTS. Job prompts carry business logic only; recovery
   mechanics are system-owned. One shared scheduled-run guidance block in
   the runner prompt seam replaces per-job tool rules.

5. HUMAN AUTHORITY. Human approval remains the sole authority for grants
   and amendments (0121 unchanged). All owner-facing copy is plain
   language.

## Acceptance criteria

- The roadmap acceptance criteria for JOBFLOW-1 (typed denials observable;
  card with working buttons + defined recovery; fix-proposal approve →
  both templates → durable resume; business-only prompts; live gate).
- The live acceptance gate: the real KnackLabs job, the exact flagged argv
  (gog sheets get <id> <range> --account <email>), a card with buttons in
  the owner's Telegram, the owner's tap, both templates applied, the job
  resumed and writing leads, no duplicate card — plus the crash/restart
  fault matrix (kill between preparation/dispatch, after send-begun,
  during reconciliation).

## Non-goals

Interactive-lane permission semantics for delivered prompts (unchanged);
the classifier (interactive-only per 0121); MEM-1; JobPrimingService
cleanup; guidance diet.
