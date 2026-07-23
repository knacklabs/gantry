---
name: finish-approved-plans-fully
description: "After plan approval, execute the entire plan without pausing mid-execution to ask for prioritization or permission"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fa541ddd-bc69-4065-a506-3c8eba5b0141
---

Once the user approves a plan (ExitPlanMode approval or an explicit "continue"/"finish everything"), implement ALL of it end to end. Do not pause after each milestone to ask which part to prioritize next or to re-confirm scope — the prioritization was already settled when the plan was approved.

**Why:** The user was visibly frustrated by repeated mid-execution check-ins ("Finish everything, that is what planned, why asking in middle again") even though each increment was verified. Asking again reads as not trusting the approved plan.

**How to apply:** After approval, work through every task in the plan, delegating bounded slices and verifying each (typecheck + targeted tests). Report progress as you go, but keep executing. Only stop to ask on a genuine blocker or a decision the plan never covered that sensible defaults cannot resolve.
