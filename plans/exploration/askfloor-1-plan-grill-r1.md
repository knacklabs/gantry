# ASKFLOOR-1 PLAN grill — round 1 (read-only, adversarial, emit under ~700 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Read `plans/exploration/askfloor-1-plan-source.md` (the plan; skip the frontmatter decision list) and interrogate it against: the confirmed spec `docs/specs/askfloor-1-judge-actually-judges.md` (AC1-AC8, owner rulings 2026-09-02), decisions `docs/decisions/0040-*`, `0043-*`, `0052-*`, `0121-*`, `0124-*`, `0134-*`, `0144-*` and the drafted `docs/decisions/0153-learned-decisions-project-into-job-grants.md`, and the code at the file:lines the plan cites — verify each cited seam exists and does what the plan says (read only what you need).

Hunt, each with file:line and a verdict:
1. OVER-BUILD: simpler shapes the plan misses (the grill hunts the smallest plan that satisfies the criteria).
2. RAILS WIDENING IN DISGUISE: does anything leak into the shared deterministic rails consulted by ask/auto_strict/autonomous — especially "kind match without the trusted-root check" (memory-side, interactive-auto only, or not?) and the two parser fixes?
3. TASK BOUNDEDNESS: are T1-T4 disjoint in write scope, each traceable to a criterion, sized for one Codex worker each; would you split or merge?
4. DECISION HYGIENE: is 0154 needed as a record; does 0153 amend 0121 correctly and narrowly; any technology/tooling pick left implicit.
5. INVARIANCE HOLES: ask mode, auto_strict, autonomous (0121), YOLO backstop, inline-scheduled (`inline-agent-loop-tools.ts:408`), the 0153 projection matrix (exact allows / near-miss cards / revoked re-cards).
6. TAP BUDGET REALITY: for AF-AC8 S1-S6, does each task deliver what the plan claims, in that order?
7. CONTRACT SHAPE: is the "thin coordinator + typed enums + domain errors" rule realistic at the named seams?

OUTPUT: numbered findings — claim, file:line, class (correctness|scope|contract-gap|decision-conflict|over-build), severity (blocker|gap|nit), smallest fix. Then a verbatim list of OWNER-LEVEL questions (things only the owner can decide). End with "PLAN SOUND" or the blocker count. No edits.
