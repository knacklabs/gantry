# ASKFLOOR-1-T3a task-contract grill — round 4 answer (gpt-5.6-sol @ xhigh)

1. **Legacy refusal error name conflicts.** AC2 and the repository focus require `HumanDecisionRequiresTypedAccessError`, but another `reviewer_focus` entry still says `HumanDecisionRequiresTypedWriteError`. Minimal fix: one name, covering legacy `put/get/list/revoke`.
2. **The `canonicalPath` fold is incomplete in `reviewer_focus`.** The scope-key entry first requires the boundary's `canonicalPath`, then reverts to `path.resolve for native` and places native writes inside the virtual clause. Minimal fix: keep native in the native clause, virtual to gantry `file` write/promote, replace `path.resolve` with the boundary's `canonicalPath`.

Non-blocking: the other four round-4 folds are consistent across AC, reviewer focus and leaves; the boundary already computes the canonical candidate before returning success (`permission-prospective-write.ts:25,63`); no conflict with 0154 / 0118 / 0107 / 0054; the shared boundary and its test are owned only by T2b then T3a.

## Fold (orchestrator, contract v5 — converged)

Both residues were `reviewer_focus` paraphrases drifting from the ACs. Fix applied at the root: the scope-key and domain-error entries now DEFER to AC3/AC2 instead of restating them. Owner rule (2026-09-06): reviewer_focus points at ACs, leaf titles list cases, and a wording-only fold gets no confirmation round — the four rounds' substantive findings (r1 nine, r3 six) are all folded and r4 confirmed the four semantic folds consistent; the two textual residues are corrected here. Contract v5 is final.
