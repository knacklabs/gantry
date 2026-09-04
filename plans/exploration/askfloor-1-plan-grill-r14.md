# ASKFLOOR-1 PLAN grill — round 14 (read-only, adversarial, emit under ~250 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 13 returned 1 blocker + 2 gaps, no owner questions. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) and decision 0154 were revised:
1. Remembering is write-gated to DM `interactive_auto`: host stamps lane eligibility into the prompt binding at render, both settlement chokepoints re-derive it from host state before writing; forged/replayed/stale `remember` callbacks for ask/auto_strict/group/job prompts settle once-only and never persist; tests per excluded lane (T3c).
2. Both stale "never learn" clauses now read "never learn an Allow".
3. End-to-end S2 fixture (tap → persist → reuse) moved to T3c; T3b keeps consult-only tests with seeded records.

Verify each is closed; hunt anything NEW (over-build, rails widening, invariance holes, AF-AC8 ownership S1 T2a / S2 T3c / S3 T1 / S4 T5a / S5 T4 / S6 T6 / listing T5b, boundedness of the 10 tasks, decision hygiene 0153/0154 vs 0052/0118/0121).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
