BLOCKING findings

1. The receipt fold still conflates the raw claimed code with the effective post-validation code. The plan preserves the tapped code verbatim while downgrading an unoffered code to its scalar base, yet says the formatter derives copy from the tapped code (`askfloor-1-t5a-taskplan.md:12,16`). Remember codes collapse to scalar modes (`apps/core/src/application/permissions/permission-remember-codec.ts:23-60`), and the decision currently retains only a claim reference without its mode (`apps/core/src/domain/types.ts:284-312`; `apps/core/src/application/interactions/pending-interaction-permission-callback.ts:620-635`). An unoffered forged code could therefore produce “Remembered” copy despite zero learning. Concrete plan fix: add a closed `receiptCode` carrier to `PermissionApprovalDecision`, set it to the post-offered-set effective code while retaining raw `claim_mode` for audit, and require the formatter to read `receiptCode`.

2. No named leaf pins that receipt carrier through live and recovered settlement. AC1 tests the formatter directly; AC2 tests scalar fallback/no learning; AC4 only proves the raw code reaches the claim (`askfloor-1-t5a-taskplan.md:25-28`). The recovery leaf likewise proves scalar application but not receipt output (`apps/core/test/unit/application/pending-interaction-permission-recovery-orchestrator.test.ts:147`). Concrete plan fix: extend the recovery leaf and each provider settlement leaf title to assert that offered codes produce their remembered receipt and an unoffered code produces the scalar once-only/cancel receipt.

3. One manifest leaf points at a nonexistent test file: `test/unit/channels/discord.test.ts` (`askfloor-1-t5a-taskplan.md:47`); the established suite is `apps/core/test/unit/channels/discord/discord.test.ts:1`. Concrete plan fix: replace the manifest path with `test/unit/channels/discord/discord.test.ts`. The count remains 63.

NON-BLOCKING notes

- The request-owned render model is now viable: the request snapshot, binding envelope, IPC payload updater, inline creation, and transactional batch reset are all explicitly assigned.
- The `canonicalRoot` → persisted place candidate → folder-tap storage fold is complete and has derivation, settlement, and tap-budget leaves.
- `memory_forget` now correctly separates outbound render-only `label` from callback `recordId`.
- Telegram’s live claim is explicitly required to retain the raw mode; adding the effective receipt-code leaf above completes its proof.
- The 0154 amendment clearly supersedes story line 162 and retains current-rails-only listing semantics. The manifest arithmetic is 63 files with a 68-file/6,800-line budget after correcting the Discord path.

NOT CLEAN
