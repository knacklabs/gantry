# ASKFLOOR-1 PLAN grill — round 6 (read-only, adversarial, emit under ~500 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 5 returned 5 blockers + 2 gaps + 1 owner question. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) was revised:
1. The unconditional unique `(app_id, agent_folder, kind, lookup_identity)` is REPLACED by two partial unique indexes (non-human on the old key WHERE kind <> 'human_decision'; human on person/scope/scope_key WHERE kind = 'human_decision' AND revoked_at IS NULL) with per-kind upsert conflict targets (`permission-decision-memory-repository.postgres.ts:82-120`).
2. T2 uses the scope-aware virtual predicate `domain/file-artifacts/protected-virtual-path.ts:23` for list filtering (+ hidden-count line) and post-resolution read refusal.
3. T2 owns the eligibility gate (`application/permissions/permission-classifier.ts:11`) widened for native Write/Edit only, and extracts the private containment helpers from `shared/auto-permission-read-only-gate.ts:248-295` into a shared module; façade-path tests.
4. `pending-interaction-permission-recovery-orchestrator.ts:55` joins T3's closed codec set with recovery/replay tests.
5. OWNER RULING: coalesced batch cards stay once-only (never write memory; one copy line; Review each yields normal remembering cards).
6. Missing settings/publisher wiring → caller produces explicit `unavailable` (`wiring_missing`).
7. T5 enumerates: batch coalescer copy, `memory_forget` union + host handler, the repository query + Postgres adapter, job-name hydration, the guidance line in `prompt-profile-service.ts`.

Verify each is closed at the seams (read only what you need) and hunt anything NEW: over-build, rails widening, invariance holes (ask, auto_strict, autonomous, YOLO, inline-scheduled), AF-AC8 ownership (S1 T2, S2 T3, S3 T1, S4 T5, S5 T4, S6 T6, listing T5), decision hygiene (0153/0154 vs 0118/0121).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
