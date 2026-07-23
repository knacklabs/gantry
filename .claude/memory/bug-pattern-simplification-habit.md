---
name: bug-pattern-simplification-habit
description: "STANDING HABIT (user directive 2026-07-19): at every cycle closeout, classify review findings into pattern families; recurring families re-rank the goals queue toward the simplification that retires them"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

User directive 2026-07-19: "Let's make it as a habit going forward. Based on
the bugs found, let's target simplification."

**Why:** a ~35-finding session analysis showed review findings cluster into a
few families, and each family maps to a specific queued simplification. Fixing
findings one-by-one treats symptoms; the families identify which structural
simplification retires the whole class.

**How to apply:** at every cycle closeout (before starting the next goal):
1. Classify the cycle's review findings into pattern families. Known families:
   (1) same fact stored twice with different lifecycles (dominant — jsonb-key
   state machines, dual sanitized copies, dual equality fns, unstable IDs);
   (2) mutation-before-authorization / delivery-failure treated as commit
   failure; (3) consolidation fidelity loss when unifying N copies (per-copy
   quirks are load-bearing — diff against EACH replaced copy); (4) generated
   defaults blind to deployment reality (drizzle "public." qualifiers, NOT
   NULL DEFAULT backfills over existing rows); (5) type-system lies (make the
   type honest, let tsc find the unsafe sites).
2. New/updated family evidence goes into `docs/architecture/goals-index.md`
   (the habit note in its preamble) and re-ranks the queue.
3. A family recurring across 2+ subsystems justifies promoting/creating a
   simplification goal that removes the pattern's substrate, not more spot
   fixes.

Applied 2026-07-19: durable-work primitive promoted to locked-next (family 1
found in permission storage + settings export + async tasks, including NEW
jsonb-key state introduced by #230's own follow-up feature). Related:
[[goal-pipeline-mandatory]], [[autoreview-local-before-commit]].
