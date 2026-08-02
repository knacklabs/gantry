---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-24
---

# Decision Provenance And Risk Label

## Context
Live testing showed the agent cannot tell WHO decided a permission — it conflated
"the classifier rated this low-risk" with "this was allowed", when in fact the
rails hard-floor dangerous commands to ASK before the classifier ever runs. The
decision already carries `decidedBy` (rails / rule / classifier / human) but it is
dropped before the agent-facing result; and the classifier's `risk_level` is
computed then discarded, so neither the agent nor the user-facing prompt shows a
risk label. The user also asked that an approval prompt carry a risk
label/severity (destructive vs network vs secret).

## Decision
Surface decision provenance and risk as first-class, legible signals: (1) the
agent-facing tool result (deny message / allow reason) includes `decidedBy`; (2)
the classifier `risk_level` (low/medium/high/critical) plus a derived `category`
(destructive/privileged/secret/network/filesystem/benign) is threaded onto the
permission request/decision and rendered as a `Risk:` line on the user-facing
prompt, reusing the existing semantic-capability `Risk:` render pattern. The
category is derived from existing signals (rail reason + classifier) — no new
classifier call.

## Consequences
- The agent stops conflating classifier-risk with the final decision; it can
  reason about escalations (auto vs human) and self-adjust.
- The risk label is ADVISORY legibility, not a new gate — the hard-floors remain
  the security control — see [[permission-holistic-redesign]].
- Adds `risk_level`/`category` fields to `PermissionApprovalRequest` and
  `PermissionApprovalDecision`; all four channels render the new bodyLine verbatim
  (no channel-delivery change).
