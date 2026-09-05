# ASKFLOOR-1-T2b task-contract grill — round 15 answer (gpt-6-astra @ high)

1. **The plan still gives conflicting lane-absent instructions.** [Scope:7](.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md:7), [Decisions:26](.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md:26), and [Risks:35](.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md:35) retain “no native verdict” outside `interactive_auto` except for `capability_run`. That contradicts refined AC2 and can reproduce the inline regression. **Minimal fix:** replace those residual clauses with the current partition: HIGH asks in every lane; lane-absent Gantry `ambiguous` asks; `ambiguous` returns `undefined` under `interactive_auto`/`auto_strict`; LOW returns a native allow only under `interactive_auto`.

Non-blocking notes:

- AC2, AC6, Surface Impact, diagram `NV`, and reviewer focus otherwise agree. [0155 bullet 13:37](docs/decisions/0155-default-allow-gantry-tools-interactive-auto.md:37) explicitly refines bullet 12; its historical “anywhere” wording is superseded. This preserves 0130 and does not widen the deferred inline 0121 gap.
- **Minimal source change:** at [native-risk helper:51](apps/core/src/runtime/permission-classifier-native-risk.ts:51), return `{ risk_level: 'high', reason: risk.reason, latencyMs: 0, status: PermissionClassifierStatus.Skipped }` for `ambiguous` when `input.lane === undefined`; retain `undefined` for ambiguous rows with a lane.
- The [required leaf:456](.factory/stories/ASKFLOOR-1/decomposition.json:456) is provable after that change. Update the existing [test:1050](apps/core/test/unit/runtime/permission-classifier.test.ts:1050) to the exact required title and add an unregistered suffix to its lane-absent native-ask loop, asserting the allow-leaning stub is never called. Keep the interactive-auto fallback assertion and inline suite unchanged.
- No files written; no tests run.

## Fold (orchestrator)

Same single blocker as sol r15 (four summaries); folded in 9118b7d94. Round 16 confirms.
