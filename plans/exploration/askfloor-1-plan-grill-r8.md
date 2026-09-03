# ASKFLOOR-1 PLAN grill — round 8 (read-only, adversarial, emit under ~400 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 7 returned 5 blockers + 1 gap + 1 owner question. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) was revised:
1. T6 explicitly owns BOTH outage hooks (IPC consult helper + inline live consult helper `inline-agent-loop-tools.ts:399-445`) with tests per path.
2. T4 threads the canonical job owner `execution_context.personId` into both job permission paths (`jobs/execution-phases-run.ts:185,296`; `inline-agent-loop-tools.ts:375`); unresolved identity projects nothing.
3. The all-mode attachment birthright now lives in 0154's Decision text as an explicit amendment of 0052 and 0121 (`docs/decisions/0154-*`).
4. T1 scaffolds the AF-AC8 replay harness with S3; each later task adds its own fixture; T6 adds S6 + the aggregation run without editing earlier tests.
5. OWNER RULING (2026-09-03): buttons on the 10 newest; `/permissions all` prints every record as plain text with ids; `/permissions forget <id>` revokes any record — AF-AC8 listing reworded.
6. T3 split into T3a persistence / T3b consult+settlement; T5 into T5a card UX / T5b `/permissions`; 8 tasks, sequential, dependencies named.

Verify each is closed at the seams (read only what you need); then hunt anything NEW: over-build, rails widening, invariance holes, AF-AC8 ownership (S1 T2, S2 T3b, S3 T1, S4 T5a, S5 T4, S6 T6, listing T5b), task boundedness of the 8 tasks, decision hygiene (0153/0154 vs 0052/0118/0121).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
