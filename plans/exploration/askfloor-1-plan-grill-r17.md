# ASKFLOOR-1 PLAN grill — round 17 (read-only, adversarial, emit under ~200 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 16 returned 2 blockers + 1 question. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) and decision 0154 were revised:
1. Excluded lanes (ask, auto_strict, job, group) keep today's controls UNCHANGED, durable-rule approvals included (`ipc-permission-classifier-decision.ts:431`); only `human_decision` learning/consultation is off there — AF-AC3, §3, §5/T5a and 0154 aligned (this follows the story's non-goal "ask/auto_strict/YOLO semantics unchanged"; no new owner decision).
2. AF-AC8 S5 moved to T5b (after T4, which keeps the projection matrix).

Verify both are closed; hunt anything NEW (over-build, rails widening, invariance holes, AF-AC8 ownership S1 T2a / S2 T3c / S3 T1 / S4 T5a / S5 T5b / S6 T6 / listing T5b, boundedness, decision hygiene).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
