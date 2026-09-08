BLOCKING findings

1. None. No concrete plan fix required.

NON-BLOCKING notes

1. AC2 now explicitly requires `railAsk.hardFloor !== true`, closing the gap in `apps/core/src/runtime/ipc-permission-classifier-decision.ts:409-431` before the Allow branch at `:530-542`. Its required leaf covers each typed signal with live and cached Allows and pins card fallback.
2. AC2 correctly separates the current meta-executor case at `apps/core/test/unit/runtime/ipc-permission-classifier-decision.test.ts:338-371` from a new job classifier-Allow leaf requiring `auto_classifier` plus `railProvenance`.
3. AC3 replaces the stale combined leaf at `apps/core/test/unit/bootstrap/inline-agent-loop-tools.test.ts:1086-1186` with separately pin-able scheduled-owner projection-hit and blank-owner fallthrough leaves, including zero-call and audit expectations.
4. AC3 now cites `inline-agent-loop-tools.ts:390-398`, not the misleading single-line `:395`.
5. The required-leaf descriptions are specific enough to pin all three folds without conflating their behaviors.

CLEAN
