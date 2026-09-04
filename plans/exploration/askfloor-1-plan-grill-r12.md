# ASKFLOOR-1 PLAN grill — round 12 (read-only, adversarial, emit under ~300 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 11 returned 2 blockers + 2 gaps + 1 owner question. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) and decision 0154 were revised:
1. The complete `memory_forget` affordance/callback union contract (incl. the `domain/message-actions.ts` entry) is T5a's; T5b keeps the host handler and listing.
2. OWNER RULING (2026-09-03): group/channel requests have no memory person, so in groups there is NO remembering — once-only buttons, no "will remember" lines, nothing written or consulted; `/permissions` in groups shows the mode line + "Remembered decisions are a DM feature."; 0154 records it.
3. CHECK covers `acting_person_id, outcome, scope, scope_key` for human rows; Postgres rejection tests.
4. The unreachable "remembered Allow lost to a hard restriction" copy is removed.

Verify each is closed; hunt anything NEW (over-build, rails widening, invariance holes, AF-AC8 ownership S1 T2a / S2 T3b / S3 T1 / S4 T5a / S5 T4 / S6 T6 / listing T5b, boundedness of the 10 tasks, decision hygiene 0153/0154 vs 0052/0118/0121).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
