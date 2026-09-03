# ASKFLOOR-1 PLAN grill — round 13 (read-only, adversarial, emit under ~250 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 12 returned 1 blocker + 2 gaps, no owner questions. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) and decision 0154 were revised:
1. Exact remembered NO now runs FIRST — before hard restrictions; protected destinations never learn an Allow but do learn a No (full effect hash); protected-path cards offer No (remembered) + Allow once; repeat-protected-denial test.
2. `.github/workflows/ci.yml` removed from T1; root-lint CI wiring is a separate quickfix follow-up.
3. Teams listing renders per-row ActionSets / chunked cards (`channels/teams/cards.ts:629` cap) with a ten-record test (T5a).
Also folded from the UX lane: group cards carry one pre-tap line; group `/permissions` copy.

Verify each is closed; hunt anything NEW (over-build, rails widening, invariance holes — especially whether a deny-first stage can ever widen or leak to ask/auto_strict/autonomous — AF-AC8 ownership, boundedness of the 10 tasks, decision hygiene 0153/0154 vs 0052/0118/0121).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
