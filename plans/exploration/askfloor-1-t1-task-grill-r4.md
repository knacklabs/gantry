# ASKFLOOR-1-T1 TASK grill — round 4 (read-only, adversarial, emit under ~300 words; factory/prompts/griller.md --gate task)

You did NOT author this contract. Round 3 returned 3 blockers + 1 gap + 1 nit (both recommended answers taken). The task `ASKFLOOR-1-T1` in `.factory/stories/ASKFLOOR-1/decomposition.json` and the saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md` were revised:
1. T1 is IPC-ONLY: the IPC helper computes the pre-analysis at its route guard and passes it to the coordinator as an OPTIONAL typed input; the coordinator derives no lane facts; inline (`inline-agent-loop-tools.ts:389-395`) and `core-tool-permission-coordinator.ts:61` pass none and stay byte-for-byte; T3b adds the inline lane input later.
2. `railProvenance` is canonical: optional field on `PermissionApprovalDecision` (`domain/types.ts:298-311`, T1's only addition there), in the signed IPC payload (`ipc-signing.ts:10-22`) and both runner decoders (`permission-ipc-client.ts:59-75,371-390`); round-trip leaf test; files in write_scope.
3. Hard-boundary predicate is genuinely pure: a conservative string predicate `isSensitivePathShape` (superset of the filesystem-backed checks; `TODO(T2a)` unify), plus `-H/-L/-follow` vetoed; the safety leaf test covers sensitive-shape, link-following, redirect, compound and pipeline.
4. The `/dev/null` proof gains an integrated mode-level leaf test in the IPC helper's test file (ask, auto_strict, job lanes).
5. Counts corrected (ten leaf tests).

Verify each is closed; hunt anything NEW. OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "CONTRACT SOUND" or the blocker count. No edits.
