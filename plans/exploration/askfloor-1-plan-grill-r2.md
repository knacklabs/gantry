# ASKFLOOR-1 PLAN grill — round 2 (read-only, adversarial, emit under ~700 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 1 returned 10 blockers + 2 gaps; the plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) was revised and the owner ruled: file-write exact = PATH ONLY (content excluded); bare `/permissions` keeps the mode display and appends the remembered list; 0153 projection = LIVE per request, revocable, never materialized; outage notice = process-local best effort. Decision `docs/decisions/0153-learned-decisions-project-into-job-grants.md` was rewritten around 0121's "pure function of declared grants"; `0154-human-decision-memory-generic-scope.md` amended.

Verify each round-1 fix is actually closed at the cited seams (read only what you need):
1. Lane guard `permissionMode === 'auto' && !hostJobId` (auto_strict keeps the veto) — `app/ipc-permission-classifier-decision.ts:67-74,307-308,369-401`.
2. `find` stays fail-closed in the shared parser; the auto-only analyzer `auto-read-only-meta-executor` is consulted only inside the interactive-auto veto branch — does anything still leak to `family-rule-synthesis.ts:24` / `durable-access-policy.ts:189`? Is the one shared `pathCandidates` fix + assumption A-askfloor-1 acceptable?
3. Coordinator lane contract — host-derived `lane` + rail signal inputs; memory stage replaces the out-of-root tail exit (`permission-decision-coordinator.ts:149-200`) for interactive_auto only. Can it be enforced as written?
4. Human-decision semantics — Allow AND No learned; NEW resolution kind `remember` at `ipc-interaction-processing.ts:334-359` / `inline-agent-loop-tools.ts:503-550`, bypassing `allow_persistent_rule` (`permission-decision.ts:232-264`); `human_decision` provenance codec at `types.ts:255-258`; rail-version check per scope. Any hole?
5. Path-only exact for file writes — is `human-decision-scope.ts` the right single owner; does protected-path exclusion hold at every write shape (FileWrite, FileEdit, `file write`, `promote_scratch`, shell redirects)?
6. FileWrite seam now at the classifier caller via `native-file-write-risk.ts`; `deepagents-shell-filesystem-guard.ts` untouched — correct?
7. 0153 rewrite — does it now amend 0121 narrowly and truthfully; are the two projection seams (`ipc-permission-classifier-decision.ts` autonomous branch; `inline-agent-loop-tools.ts:408`) real and sufficient; test rewrite at `:1194-1249`.
8. `/permissions` extension at `session-command-parse.ts:25-39` / `session-commands.ts:580-585` + `admin-permissions.ts` rows — collision-free, no per-provider registration?
9. T1–T6 boundedness: disjoint write scopes as named (four tasks touch `ipc-permission-classifier-decision.ts` in distinct functions — acceptable or must it be pre-split?); one Codex worker each; every AF-AC8 scenario owned exactly once (S1 T2, S2 T3, S3 T1, S4 T5, S5 T4, S6 T6, listing T5).
10. Typed results instead of blanket domain errors; outage latch identity (app, provider account, conversation) + episode reset.
11. Anything NEW the revision introduced: over-build, rails widening in disguise, invariance holes (ask, auto_strict, autonomous, YOLO, inline-scheduled), decision hygiene.

OUTPUT: numbered findings — claim, file:line, class (correctness|scope|contract-gap|decision-conflict|over-build), severity (blocker|gap|nit), smallest fix. Then a verbatim list of OWNER-LEVEL questions (only things the owner must decide; none if none). End with "PLAN SOUND" or the blocker count. No edits.
