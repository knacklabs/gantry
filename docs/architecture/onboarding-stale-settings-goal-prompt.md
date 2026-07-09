# Goal Prompt: Onboarding "stale settings" Failure At Create Runtime

## Objective

Fix `gantry setup` failing at the final "Create Runtime" step with:

```
Setup blocked: could not save config (Settings mutation is based on stale settings; reload latest desired state and retry.)
```

The failure is deterministic — re-running setup hits the same error every time, so the error's own "re-run `gantry setup`" advice never converges. Reproduced on a fresh machine (Telegram + kimi/openrouter draft).

Use ponytail. Root cause, not symptom. No compatibility shims.

**Companion symptom (same loop, second bug):** after the failure, re-running `gantry setup` does NOT resume at the review step as promised ("your answers are saved and pre-filled") — it re-asks the Telegram bot token and then the storage step, walks forward to Create Runtime, and fails again. The resume state (`apps/core/src/cli/setup-flow-state.ts:116-132`) persists chat/schema metadata but not the bot token; on reload the token falls back to `env.TELEGRAM_BOT_TOKEN` (`setup-flow-state.ts:265`), which the current flow no longer writes to `.env` — so the prefill promise is structurally broken for secrets even though attempt 1 already stored the token in the credential secret store (`storeRuntimeSecretInput` succeeded before the stale failure).

## Root Cause (traced — verify, then fix)

The stale check (`apps/core/src/config/settings/settings-import-service.ts:172-180`) requires the mutation's base (`previousSettings`) to render byte-identical (`stableJson`) to `latest.settingsDocument`. `persistOnboardingConfig` (`apps/core/src/cli/onboarding-config.ts:99`) violates this two ways:

1. **Two writes with an in-memory base.** When channel secrets are present it calls `writeDesiredRuntimeSettings` TWICE (lines 163 and 276). The final write's base is `structuredClone(settings)` taken after the first write — not a reload of the latest revision. Anything that advances or reshapes the latest revision between the two writes makes the final write permanently stale.
2. **Echo appends land in that window.** Two mechanisms:
   - The running service's settings.yaml watcher (`apps/core/src/runtime/settings-reload-watcher.ts:94-146`) re-imports the file the first write just wrote, **with a revision mirror** (`createdBy: 'settings.yaml:auto-import'`) whenever `settingsToRevisionDocument(parsedFile)` ≠ latest document — any renderer/parser round-trip asymmetry triggers an echo revision append.
   - `applyRuntimeSettingsDesiredState` may mutate or reshape applied settings relative to the caller's in-memory object (check for in-place mutation of the `settings` argument inside the first write; if found, that alone breaks the second write with no service running).

Either way, the final write compares a stale in-memory clone against a moved head → hard failure with no retry.

## Required Behavior

- `gantry setup` completes the Create Runtime step on a fresh machine and on re-run after a previous failure, with or without a running Gantry service watching settings.yaml.
- Onboarding performs its settings mutation atomically from a freshly loaded base, and retries (bounded, reload + reapply) if a concurrent revision lands mid-flight.
- No behavioral change to what onboarding persists (same final settings content).
- Re-run after a failed Create Runtime resumes with answers pre-filled and does not re-ask steps already answered: a channel secret already stored in the credential secret store (detectable via the provider account's stored secret refs, see `hasEnabledProviderWithStoredSecretRefs` in `onboarding-config.ts`) counts as answered — do not re-prompt for the token; the storage step must prefill from the persisted draft/env (`GANTRY_DATABASE_URL` is written by attempt 1). If a secret is genuinely absent everywhere, re-asking only that one step is acceptable.

## Implementation Shape

In `apps/core/src/cli/onboarding-config.ts`:

1. **Collapse to one write.** Restructure `persistOnboardingConfig` so all settings mutations (agent name, storage, model defaults, harness, credential mode, providers, provider accounts, memory flags) are applied by a pure function over a base snapshot, then ONE `writeDesiredRuntimeSettings` call. The current first write (line 163) exists only to sequence ahead of secret stores — `storeRuntimeSecretInput` (capability secret store) does not read or write settings, only PG + env, so the pre-write is unnecessary; confirm and delete it.
2. **Bounded stale retry.** On the stale/conflict error from `writeDesiredRuntimeSettings`, reload the base via `loadDesiredRuntimeSettingsForWrite` and reapply the same pure mutation function, retry up to 3 times before surfacing the existing error. This makes setup robust to watcher echo appends racing the write.
3. **Check the in-place mutation seam.** If `importWorkstationSettings`/`applyRuntimeSettingsDesiredState` mutates the caller's `settings` argument in place, fix at that seam (clone before apply or operate on the normalized copy) — one guard where all callers route through, not per-caller defensive clones.
4. **Round-trip identity guard (watcher echo).** Add a test that the onboarding-produced settings survive `render settings.yaml → parse → settingsToRevisionDocument` byte-identically (`stableJson`) to the document stored in the revision. If it fails, fix the renderer/parser asymmetry it exposes — that asymmetry is what makes the service watcher append `settings.yaml:auto-import` echo revisions after every CLI write.

Do not change the stale-check semantics in `settings-import-service.ts` (it is correct optimistic concurrency); the fix is on the onboarding caller and any round-trip asymmetry.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Setup's Create Runtime step converges; one revision append instead of two. |
| `settings.yaml` | Unchanged content | Same final settings; written once. |
| Postgres/runtime projection | Changed | One onboarding revision (plus retries only on real conflicts). |
| Control API / SDK / CLI | Unchanged | No contract change. |
| Docs/prompts | Unchanged by design | Error copy already correct once retry works. |
| Tests/verification | Changed | Reproducing tests + round-trip identity guard. |

## Acceptance Criteria

- A test reproduces the current failure: with a fake/real revision store, a concurrent revision append between onboarding's base load and write causes today's code path to throw stale — and the fixed code retries and succeeds.
- A test proves onboarding with channel secrets performs exactly ONE revision append when nothing races.
- A test proves the round-trip identity: onboarding settings → settings.yaml render → parse → `settingsToRevisionDocument` equals the stored revision document (`stableJson`).
- A test proves retry is bounded and surfaces the existing stale error after exhaustion.
- If in-place mutation by the apply path is confirmed, a test pins the fix at that seam.
- A test proves resume after a failed Create Runtime skips the channel-token prompt when the secret ref is already stored, and prefills the storage step from the persisted draft/env.
- Existing setup/onboarding unit + e2e tests stay green (known pre-existing failures exempt: jobs-runs-memory-flow integration, runtime-setup-doctor e2e).

## Focused Verification

```bash
npm run test:unit -- apps/core/test/unit/config/desired-settings-writer.test.ts apps/core/test/unit/config/settings-import-service.test.ts apps/core/test/unit/config/runtime-settings.test.ts
npm run test:unit -- apps/core/test/unit  # broaden once focused set is green
npm run build
python3 .codex/scripts/check_architecture.py
```

Locate and run the existing onboarding-config / setup-flow tests too (search `apps/core/test` for `onboarding` / `setup-flow`).

Runtime smoke (manual, later): fresh runtime home + fresh schema, run `gantry setup` end-to-end with a Telegram token while a Gantry service is running against the same home; Create Runtime must succeed.
