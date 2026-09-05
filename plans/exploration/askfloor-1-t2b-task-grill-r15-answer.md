# ASKFLOOR-1-T2b task-contract grill — round 15 answer (gpt-5.6-sol @ xhigh)

1. Bullet-13 parity is incomplete. The task plan still says there is no native verdict outside `interactive_auto` except `capability_run` at `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md:7`, repeats that rule at `:26`, and says an absent lane has no native verdict at `:35`. The recorded objective also says unqualified ambiguous rows go to the classifier at `.factory/stories/ASKFLOOR-1/decomposition.json:344`. These contradict refined AC2/AC6 and decision 0155 bullet 13. Minimal fix: make all four summaries state the three-way rule—`interactive_auto` consults, `auto_strict` yields nothing, lane absent asks natively—and re-record the decomposition.

Non-blocking notes:

- Decisions 0121 and 0130 remain compatible; decision 0155 bullet 13 explicitly refines bullet 12.
- The required leaf at `.factory/stories/ASKFLOOR-1/decomposition.json:456-458` is provable. The implementer must extend/rename the existing leaf at `apps/core/test/unit/runtime/permission-classifier.test.ts:1050-1136` to cover a lane-less unregistered suffix; the inline expectation at `apps/core/test/unit/bootstrap/inline-agent-loop-tools.test.ts:1253-1276` remains unchanged.
- Minimal source change: at `apps/core/src/runtime/permission-classifier-native-risk.ts:51-57`, return the native ask result for `ambiguous` when `lane` is absent; retain `undefined` for ambiguous rows under `interactive_auto` and `auto_strict`.
- Read-only review only; no files changed and no tests were run.

## Fold (orchestrator)

All four summaries rewritten to the three-way rule (plan Scope line 7, Decisions line 26, Risks line 35; objective in the generator), plan re-saved and decomposition re-recorded. Round 16 confirms.
