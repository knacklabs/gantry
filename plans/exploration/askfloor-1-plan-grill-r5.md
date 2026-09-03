# ASKFLOOR-1 PLAN grill — round 5 (read-only, adversarial, emit under ~500 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 4 returned 6 blockers + 2 gaps, no owner questions. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) was revised:
1. T2 owns the host-side list/read protection check in `jobs/ipc-file-artifact-handlers.ts:109-147,168-175` (list filters, read refuses) + adversarial tests.
2. `acting_person_id` nullable column + CHECK (`kind = 'human_decision' ⇒ NOT NULL`) + PARTIAL unique index `(app_id, agent_folder, acting_person_id, scope, scope_key) WHERE kind = 'human_decision' AND revoked_at IS NULL`; existing key preserved for other kinds.
3. ONE decision order stated once in §1: pre-analysis → hard restrictions → exact remembered deny → reviewed rules/rails → remembered allows → tail; §3 references it.
4. T4 owns the audit write in both job lanes (IPC `recordDecision` :489-521 + `recordDecision` port threaded into the inline projection helper); T5 owns the typed list query + job-name hydration.
5. `remember` closed codec file set under T3 incl. `pending-interaction-prompt-binding.ts:39-63`, `pending-interaction-permission-callback.ts:292-325,496-535`, `worker-coordination-permission-prompt.postgres.ts:39-89`.
6. `revokeById(appId, agentFolder, actingPersonId, recordId)` → `applied | already_revoked | not_found`, T3 port, T5 affordance handler; cross-person → not_found.
7. `runtime/permission-classifier.ts` owned entirely by T2 (native-risk branch + status stamping); T6 consumes only.
8. Verify Plan: `python3 factory/scripts/verify.py` authoritative; suites are focused required_tests; root lint CI wiring recorded as follow-up, not in story.

Verify each is closed at the seams (read only what you need) and hunt anything NEW: over-build, rails widening, invariance holes (ask, auto_strict, autonomous, YOLO, inline-scheduled), AF-AC8 ownership (S1 T2, S2 T3, S3 T1, S4 T5, S5 T4, S6 T6, listing T5), decision hygiene (0153/0154 vs 0118/0121).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
