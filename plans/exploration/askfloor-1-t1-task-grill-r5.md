# ASKFLOOR-1-T1 TASK grill — round 5 (read-only, adversarial, emit under ~300 words; factory/prompts/griller.md --gate task)

You did NOT author this contract. Round 4 returned 5 blockers (both recommended answers taken). The task `ASKFLOOR-1-T1` in `.factory/stories/ASKFLOOR-1/decomposition.json` and the saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md` were revised:
1. Assumption A-0069 recorded on the approved plan (`plans/active/...md`, `plans/assumptions.md`): the coordinator is a declared T1/T3b shared file, T1 limited to the optional analysis input + typed `tail(context)` seam. The pre-analysis is a NEW pre-coordination step in the IPC helper (`:95-170`), distinct from the tail's route guard (`:184-218`) which only consumes the context.
2. The Anthropic runner decoder (`adapters/llm/anthropic-claude-agent/runner/permission-callback.ts:301-387`, `runner/types.ts:119-144`) and its test file are in write_scope with a round-trip leaf test.
3. `PermissionLane`, `RailSignal`, `RailProvenance` are domain-owned (new `domain/permission-lane.ts`); the harness uses `PermissionApprovalDecision['decidedBy']`, the existing `PermissionDecisionSource` (`domain/types.ts:255`) and `RailProvenance`.
4. AC3 enumerates the complete stage order (pre-coordination route analysis, [T3b] exact remembered deny, hard restrictions, reviewed rules, trusted-root resolution, deterministic rails, classifier-cache read, [T3b] remembered allows, tail), pinned by a stage-order leaf test.
5. `isSensitivePathShape` scans every operand and predicate value; `.` allowed, `..` and dot-names denied.

Verify each is closed; hunt anything NEW. OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "CONTRACT SOUND" or the blocker count. No edits.
