BLOCKING findings

1. AC2 names the wrong IPC seam and is not implementation-exact. Valid-route jobs do not currently “short-circuit to terminal denial”: the job guard denies only a missing route (`ipc-permission-classifier-decision.ts:275-300`) and otherwise returns `undefined` (`:302`). The actual exclusions are the job-wide cache bypass (`:183-187`), classifier eligibility limited to interactive/strict lanes (`:339-343`), rail relaxation/provenance limited to `InteractiveAuto` (`:415-431`), and uncacheable native-Allow logic limited to that lane (`:504-518`). Conversely, `!input.hostJobId` (`:544-564`) is what lets a classifier ASK reach the existing card path (`:565-622`) and must remain.

   Concrete plan fix: AC2 must explicitly require:

   - Remove `hostJobId` from `skipClassifierVerdictCache`.
   - Add trusted `input.hostJobId`—never worker `request.jobId`—to classifier eligibility.
   - Reuse `consultPermissionClassifierBeforePrompt` (`:361-397`) so the first-ask floor remains authoritative.
   - Extend only the existing overridable rail predicate to jobs, explicitly excluding `hardFloor`, retaining the two typed signals/read-only-meta predicate and `railProvenance`.
   - Apply interactive-auto’s FileWrite/FileEdit/Gantry-native cache-write exclusions to jobs.
   - Preserve both the missing-route guard and the `!hostJobId` card fallthrough.

2. “Classifier allow/deny honoured, ask → card” is not a closed contract. IPC explicitly handles only classifier `allow` (`ipc-permission-classifier-decision.ts:530-542`); every other result proceeds toward the prompt/card path. Inline likewise special-cases only `allow` (`inline-agent-loop-tools.ts:443-448`) and converts scheduled non-Allow to the existing cancellation/card result (`:450-460`). Decision 0043 is accepted as “Classifier Risk Only, Engine Owns Authorization” (`docs/decisions/0043-classifier-risk-only-engine-authz.md:1-7`).

   Concrete plan fix: use the actual closed result vocabulary—apparently `allow | ask`—and state that the engine maps classifier risk to authorization. If a distinct classifier `deny` is genuinely intended, name its type owner, engine mapping, provenance, IPC and inline branches/tests, and add every newly touched file to scope.

3. AC2’s generic “rewrite the 0121 pins” misses required regressions. These IPC blocks currently pin jobs away from the new behavior and must be named:

   - `ipc-permission-classifier-decision.test.ts:293`
   - `:317-335` — job row plus zero classifier calls
   - `:338-371` — job retains the meta-executor veto
   - `:374-404` — explicit job zero-classifier assertion
   - `:462` — retitle narrowly; its missing-route zero-call assertions at `:550-553` remain correct

   Add explicit job proofs for first-ask behavior, cache hit/miss/write exclusions, the two overridable rails with `railProvenance`, hard-floor zero consultation, classifier Allow, and classifier ASK → card.

NON-BLOCKING notes

1. The inline ordering already works once projection is inserted before `tail`: coordinator call at `inline-agent-loop-tools.ts:390-398`, tail/classifier at `:399-442`, Allow at `:443-448`, scheduled ASK handling at `:450-460`. Its scheduled projection-hit subsection must change at `inline-agent-loop-tools.test.ts:1160-1186`; the projection-miss classifier proofs at `:1366-1407` and `:1416-1465` remain useful.

2. The architecture paragraph must replace the autonomous exclusion at `permission-decision-memory.md:30` and update `:26-32` with the new ladder. AC7 already owns that change.

3. All identified source, test, and documentation changes are inside the 22-file write scope (`askfloor-1-t4-taskplan.md:40`). The 24-file/2,400-line budget fits with two-file headroom—unless a genuine three-way classifier contract adds an unlisted type owner.

4. With the wording correction above, there is no conflict with accepted decisions 0115 (`Autonomous Tool Denial Terminal`, `:1-8`), 0120 (structured local-CLI invocation, `:1-8`), or 0153 (learned decisions projected as job grants, `:1-8`). Terminal denial remains for genuine denial/hard rails or a missing route; ASK remains a card.

NOT CLEAN
