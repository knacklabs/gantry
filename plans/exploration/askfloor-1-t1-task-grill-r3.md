# ASKFLOOR-1-T1 TASK grill — round 3 (read-only, adversarial, emit under ~300 words; factory/prompts/griller.md --gate task)

You did NOT author this contract. Round 2 returned 4 blockers + 2 technical questions (both recommended answers taken). The task `ASKFLOOR-1-T1` in `.factory/stories/ASKFLOOR-1/decomposition.json` and the saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md` were revised:
1. `acceptance_criteria` and `plan_contracts` are now the saved task plan's five criteria verbatim.
2. Coordinator contract: the coordinator computes the immutable pre-analysis at entry (both callers unchanged, incl. inline `inline-agent-loop-tools.ts:389-395`), resolves route mode there, runs ONE base rail evaluation, calls `tail(context)` with `{ analysis, railDecision, routeMode }`; trusted-root hypothetical rechecks (`:232-268`) unchanged.
3. `readOnlyMetaExecutor` is the explicit HARD-BOUNDARY predicate (single simple find; no compound/pipeline/redirect/subshell; none of the nine write actions; no protected/secret path argument); a ninth leaf test pins protected/secret, redirect, compound and pipeline `find` vetoes in interactive auto.
4. Provenance: `decidedBy: auto_classifier`, `source: auto_classifier`, plus a separate typed `railProvenance: { signal, reason }`; the harness return type is concrete.

Verify each is closed; hunt anything NEW. OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "CONTRACT SOUND" or the blocker count. No edits.
