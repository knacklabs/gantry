# ASKFLOOR-1 PLAN grill — round 4 (read-only, adversarial, emit under ~600 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 3 returned 8 blockers + 3 gaps. The plan at `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) was revised. Owner rulings this round: enabling the baseline `file` tool satisfies AF-AC2's approved-capability clause for list/read (entry protection stays host-side in the artifact handler); no shared group memory — when the acting person cannot be resolved nothing is remembered and the tap acts as once (`acting_person_id` NOT NULL). Decision `0154-*` amended accordingly (deny-first short-circuit; person required).

Verify each round-3 fix is closed (read only what you need):
1. AF-AC2 predicate now = action ∈ {list, read} with well-formed arguments, protection enforced at `jobs/ipc-file-artifact-handlers.ts:124-147`. Honest and provable?
2. `remember` structured DTO with ONE owner (T3) for `domain/types.ts:249-280`, normalization, settlement, and the provider scalar encodings `telegram/channel-shared.ts:51-74`, `slack/permission-action-id.ts:5-15`; T5 rendering/parsing only. Complete?
3. Deny-first memory step (exact remembered No before every rail; allows only after non-overridable rails) — reachable for destructive asks; any widening risk?
4. "used by job": T4 stamps matched record id beside jobId in the audit context (`permission-management-service.ts:502-521`); T5 adds one read query + job-name hydration. Sufficient? No pager — 10 newest + count line.
5. `memory_forget { recordId }` as a new affordance in `domain/message-actions.ts:3-64` with host handler + four-provider settlement under T5.
6. Typed status stamped at each branch of `runtime/permission-classifier.ts` (only a successful LLM verdict = answered; non-LLM branches skipped, never touch the latch).
7. `acting_person_id` NOT NULL with the composite unique key; unresolved person → not persisted, once semantics, card line.
8. Chronology: pre-analysis (lane + readOnlyMeta) → coordinator (rails → memory stage) → tail receives the completed analysis incl. the rail decision computed once. Enforceable at `ipc-permission-classifier-decision.ts:95-119,173-218`?
9. Three shared files pre-split with named helper ownership (T1/T4/T6; T3/T4; T2/T6). Bounded?
10. Nine `find` write actions. 
11. Anything NEW: over-build, rails widening, invariance holes (ask, auto_strict, autonomous, YOLO, inline-scheduled), AF-AC8 ownership.

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
