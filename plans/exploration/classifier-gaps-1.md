# Auto-mode gap: over-asking — FAST pass (read-only, emit quickly, do NOT explore beyond the listed files)

Read ONLY these files, in this order, then emit findings. Do not grep the wider tree, do not open other files — you have enough here:
1. `apps/core/src/application/permissions/gantry-tool-risk.ts` (whole file)
2. `apps/core/src/runtime/permission-classifier.ts` lines 300-420 (the consult-vs-static short-circuit)

TARGET: gantry should work like Claude Code auto mode — the classifier judges unknowns on their own risk and asks ONLY genuine risk. 

Answer two questions from those files, with file:line + a concrete minimal proposal each:
1. In `gantryToolDefaultRisk`, which static-HIGH buckets force an ask WITHOUT the LLM classifier ever running, and which of those are coarse defaults that an arg-level verdict could safely lower (e.g. read-only browser inspect already low; a send-message to an already-approved destination; a "grantable-exact" mutation)? Name each bucket, why it over-asks, and the smallest fix (arg-level risk input / narrower bucket / route-to-classifier).
2. Confirm from permission-classifier.ts:300-420 whether a tool with NO static bucket (undefined) and NO grant reaches the LLM classifier and is auto-allowed at low/medium — or whether any branch degrades to ask/deny regardless of risk (classifier unavailable, YOLO backstop, etc.).

OUTPUT: numbered findings — gap, file:line, why it over-asks, minimal proposal, target story (ASKFLOOR-1 | CARDSIMPLE-2 | new). Keep it under ~400 words. No edits. Emit as soon as you have read the two files.
