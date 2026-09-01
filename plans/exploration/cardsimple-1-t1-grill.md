# CARDSIMPLE-1-T1 task grill — cold read (read-only, no edits, keep reading TIGHT)

You did not author this task plan. Read `.factory/stories/CARDSIMPLE-1/task-plans/CARDSIMPLE-1-T1.md` cold, as an adversary trying to break the handover before a Codex implementer starts. Context: this is the T1 slice of the approved slim story plan `plans/active/CARDSIMPLE-1-one-permission-surface-family-wide-grants.md`; the simplicity loop already cut a three-value classification, adapter-level prompt changes and the lane-parity cross-product — do NOT reintroduce them.

Interrogate:
1. Can each step land where the plan says? Verify the exact seams: `commandRules` (permission-suggestion-synthesis.ts:62), the SDK inference (permission-suggestions.ts:262), autonomous recovery (autonomous-bash-recovery-rule.ts:14), the validator rejection (durable-access-policy.ts:219/:330), the match result shape (tool-execution-policy-service.ts:90-108), and the coordinator early return (permission-decision-coordinator.ts:84). Is the coordinator genuinely the single seam where durable suggestions and decision options for this path are chosen — or does one of the two IPC/SDK adapters re-derive suggestions after the coordinator returns?
2. Will `isFamilyRule` thread without touching exact/capability behavior — is the match result type shared such that adding an optional boolean is additive-only for every consumer?
3. Is the family shape `<literal argv0> *` unambiguous in the validator (no collision with existing accepted shapes; script-leaf normalization at normalizeScriptLeafRuleContent doesn't produce lookalikes)?
4. Do the three required test leaves prove the contract, and are the named test paths sensible (new family-rule-synthesis.test.ts in unit/shared; a coordinator test in unit/runtime)?
5. Anything in the plan an implementer would have to guess (a sentence with two readings)? Any missing file the steps force?

Output: numbered findings — claim, file:line, severity (blocker | design-gap | nit), smallest task-plan amendment. Say "CLEAN" if none. No edits anywhere.
