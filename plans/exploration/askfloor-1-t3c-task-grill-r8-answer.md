# ASKFLOOR-1-T3c task-contract grill — round 8 answer (gpt-5.6-sol @ xhigh)

1. **What:** Round-7 fold 1 remains contradictory and is not fully typed.  
   **Where:** The plan requires edits at both prompt exits ([task plan:9](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:9)), but AC2 still says the decision helper is untouched ([task plan:22](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:22)); both contradictions were generated into the contract ([decomposition:767](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:767), [decomposition:886](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:886)). The two live calls are at [ipc-permission-classifier-decision.ts:561](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/runtime/ipc-permission-classifier-decision.ts:561) and [ipc-permission-classifier-decision.ts:599](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/runtime/ipc-permission-classifier-decision.ts:599), behind an `IpcDeps`-typed boundary ([ipc-permission-classifier-decision.ts:68](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/runtime/ipc-permission-classifier-decision.ts:68)).  
   **Why:** An implementer must choose between “untouched” and the mandated edits, and must guess where the optional typed second argument is declared.  
   **Minimal fix:** Remove every “helper untouched” statement and name the exact local callback-type widening—or add its actual type owner to `write_scope`—while retaining both prompt-exit edits and their IPC proof.

2. **What:** Round-7 fold 3 still lacks its required missing-label leaf proof.  
   **Where:** The ruling requires `personLabel: undefined` when the host source has no label ([task plan:12](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:12)), and AC4 repeats it ([task plan:24](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:24)), but neither exact required-test title includes that assertion ([IPC leaf:839](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:839), [inline leaf:844](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:844)). The merged seams currently expose only the person ID ([IPC:141](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/runtime/ipc-interaction-processing.ts:141), [inline:376](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/apps/core/src/app/bootstrap/inline-agent-loop-tools.ts:376)).  
   **Why:** The named leaves can pass while silently omitting the explicit undefined-label case.  
   **Minimal fix:** Add the missing-host-label assertion to the exact IPC and inline leaf titles.

3. **What:** The review budget contradicts the round-8 brief.  
   **Where:** The brief requires 32 files / 3,200 lines against roughly 29 listed files ([brief:7](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/plans/exploration/askfloor-1-t3c-task-grill-r8.md:7)); the saved plan lists 32 files and grants 35 / 3,500 ([task plan:41](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T3c.md:41)), which the contract repeats ([decomposition:817](/Users/ravikiranvemula/Workdir/myclaw-askfloor1/.factory/stories/ASKFLOOR-1/decomposition.json:817)).  
   **Why:** The implementer cannot determine which measured ceiling is authoritative.  
   **Minimal fix:** Recount the intended scope and synchronize the brief, saved plan, contract, and rationale to one budget; if the round-8 brief governs, record 32 / 3,200 and remove the contradictory headroom claim.

Non-blocking notes:

- Folds 2, 4, and 5 are present: shared-seam-only forgery scope, the exact T5a producer hand-off, and the named `durable-interaction-handler.ts` carrier edit with a durability leaf.
- The six ACs equal the six `plan_contracts`; all twelve leaf titles are unique and regex-safe. Existing test-owner paths exist, with the new files identified explicitly.
- Key derivation matches merged T3b, including `trustGrowthTool: false`, host-stamped person, rails version, and effect version. Claim/recovery ordering and refresh idempotency have no additional contract blocker.
- Current counts are 865/865 for IPC, 740/740 for `domain/types.ts`, and 745/750 inline; only two are literally at their ceiling.
- No files were edited and no tests were run. Older memory was used only to locate T3b context; findings above come from the current worktree.

## Fold (orchestrator, contract v10 — wording only; no further round per the owner rule)

(1) every 'untouched' phrase removed; the optional typed second argument is declared on the helper's own IpcDeps.requestPermissionApproval signature (:68) — three one-line edits in that file; (2) the IPC and inline leaf titles pin the undefined-label case; (3) the base brief's stale budget line replaced by the saved plan's Task Decomposition line as the authority (32 files, budget 35 / 3,500).
