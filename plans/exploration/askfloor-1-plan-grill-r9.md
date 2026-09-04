# ASKFLOOR-1 PLAN grill — round 9 (read-only, adversarial, emit under ~350 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 8 returned 5 blockers + 1 gap + 2 owner questions. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) was revised:
1. Inline live consult (`inline-agent-loop-tools.ts:408-445`) also produces `wiring_missing → unavailable`; T6 tests latch/notice/reason on both paths.
2. `domain/types.ts` additions (provenance codec + `remember` DTO type) are ALL T3a's; T3b consumes.
3. Short-id contract: `/permissions all` lists active current-rails records only; 6-hex-char prefixes (extended on collision within the person's records); `forget <id>` accepts any prefix ≥ 4 chars resolved against THIS person's active records; exactly one match mutates, ambiguity never mutates (tests), replies identical to the button flow.
4. T6 is `user_facing: true`.
5. 0154 and Surface Impact aligned (ten-newest buttons + all/forget; attachment birthright in every mode).
6. Column naming: physical names follow the table's existing convention; any deviation from `constitution/pnp-database-standards.md:46-64` recorded as deliberate in the migration note.

Verify each is closed (read only what you need); hunt anything NEW: over-build, rails widening, invariance holes, AF-AC8 ownership, task boundedness of the 8 tasks, decision hygiene (0153/0154 vs 0052/0118/0121).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
