# Goal Prompt: Setup & Management UX Overhaul

## Objective

Make `gantry setup` and post-setup management trustworthy and confusion-free
for technical self-hosters — new users and existing users alike:

1. **Fix the save-path bug** that hard-blocks setup at "Create Runtime" with
   `Settings mutation is based on stale settings`.
2. **Model-first selection** — retire the user-facing "preset" concept; the
   user picks one main chat model, memory LLM defaults derive from that
   model's provider, one provider/one key by default.
3. **A light memory step** in the wizard (memory on/off; embeddings only when
   they cost an extra provider key).
4. **Live credential verification** (skippable) at setup, on
   `credentials model set|rotate`, and in doctor.
5. **Re-runnable pre-filled setup** with a jump-to-step menu as the one front
   door for reconfiguration, plus a minimal multi-agent slice.
6. **Surface restart-required changes** — every mutating CLI command tells
   the user when a change is inert until `gantry restart`.

Use ponytail. Keep changes surgical. No compatibility shims — this repo has
no backward-compat requirement (active development).

**Out of scope (documented follow-ups, do not build):** backup/export/restore
commands, `gantry storage set` beyond the setup-menu path, unifying
`gantry start` foreground vs service lifecycle (copy clarification only),
full `gantry agent` command group, agent-profile offline path, hot credential
reload for in-flight agents, `provider account rotate-secret` UX, doctor
"restart pending" detection, non-OpenAI embedding providers.

## Staged Delivery Contract

Six stages, each an independently shippable PR, implemented in order.
Stage N+1 starts only after stage N's focused verification passes.

### Stage 1 — Fix the settings save path

- `apps/core/src/config/settings/settings-import-service.ts`: the stale
  guard (lines ~165-173) compares `stableJson(latest.settingsDocument)`
  (normalized before persist, lines 142-149) against
  `stableJson(settingsToRevisionDocument(previousSettings))` (un-normalized
  caller clone). Normalize `previousSettings` with the same
  `normalizeConfiguredCapabilitiesInSettings({settings, repositories, appId})`
  before comparing. Do NOT collapse `persistOnboardingConfig`'s two writes —
  they are structural (storage config must persist before
  `storeRuntimeSecretInput` can reach the DB).
- `apps/core/src/cli/setup-flow-final-steps.ts` `runConfigStep` catch
  (112-122): actionable copy. Stale case: "another process changed settings
  during setup — re-run `gantry setup`; your answers are saved and
  pre-filled". Generic: "check Postgres connectivity (`gantry doctor`), then
  re-run `gantry setup`".
- Acceptance: a unit test with two sequential required-mirror writes where
  normalization mutates the document — the second write, using the
  un-normalized clone as `previousSettings`, succeeds (fails today).

### Stage 2 — Retire user-facing presets; per-provider defaults

- `apps/core/src/shared/model-catalog.ts`: replace
  `MODEL_PRESETS`/`ModelPresetId`/`listModelPresets`/`isModelPresetId`/
  `getModelPreset`/`DEFAULT_MODEL_PRESET_ID` with a curated map
  (anthropic → extractor haiku / dreaming sonnet / consolidation sonnet;
  openrouter → kimi×3, absorbing `MEMORY_MODEL_DEFAULT_ALIASES`) plus
  `memoryModelDefaultsForProvider(providerId)`: curated entry → else
  cheapest catalog entry for that provider supporting all three memory
  workloads (sort by inputUsdPerMillionTokens, then id) → else (perplexity)
  anthropic defaults.
- Job defaults: both presets already set `''` (inherit chat) — "apply
  defaults" resets both to `''`; no replacement structure.
- `apps/core/src/config/settings/runtime-settings-defaults.ts`: `applyModelPreset` →
  `applyModelDefaults(settings, chatAlias)`;
  `getPresetManagedMemoryDefaults`/`applyPresetManagedMemoryDefaults` →
  provider-keyed equivalents. Update re-exports in `runtime-settings.ts`.
- `apps/core/src/config/settings/model-defaults.ts`: `presetFromSettings` →
  `providerFromSettings`; drop `'preset'` field from
  `updateRuntimeModelDefaults`; `'memory': 'reset'` re-derives from the chat
  provider; chat reset falls back to `DEFAULT_SETUP_MODEL_ALIAS` ('opus').
- `apps/core/src/cli/model.ts`: delete `gantry model use-preset`; `--preset` → `--provider`;
  status "preset:" → "provider:", "preset-managed" → "provider-managed
  (from <provider>)"; preflight by provider id (drop the `isModelPresetId`
  gate). After `set chat` changes provider: warn "Memory models still on
  <old provider> — run `gantry model reset memory` to re-derive"; extend
  `noteUnconfiguredProvider` to also check memory model providers.
- `apps/core/src/adapters/llm/model-provider-preflight.ts`: `preflightModelPreset({preset})`
  → `preflightModelProvider({providerId, chatAlias?})`.
- Control API `apps/core/src/control/server/routes/models.ts` + `openapi-schemas.ts`:
  PATCH drops `preset`; GET replaces `preset`+`mode:'preset-managed'` with
  `provider`+`mode:'provider-managed'`; `providersSelectedByPatch` uses
  `memoryModelDefaultsForProvider`.
- Wizard plumbing: drop `modelPreset` from `SetupDraft`
  (setup-flow-state.ts), `OnboardingData` (onboarding-state.ts),
  `OnboardingConfigInput` (onboarding-config.ts — the preset/alias mismatch
  error disappears), `CredentialSetupDraft` (setup-credentials.ts derives
  memory models from the chat model's provider), setup-ready.ts, and the
  "Model preset:" summary line → "Model provider:". `runModelStep`
  (setup-flow-core-steps.ts:268-372): delete the preset select; "Recommended"
  pins `DEFAULT_SETUP_MODEL_ALIAS`; note "memory LLM defaults derive from
  <provider>: <aliases>".
- Acceptance: `rg -n "preset" apps/core/src` afterwards matches only
  unrelated words; unit tests for `memoryModelDefaultsForProvider`
  (curated hit, derived-cheapest hit, perplexity fallback).

### Stage 3 — Wizard UX: memory step, re-runnable setup, beautification

- Memory step: add `'memory'` to `OnboardingStep` (onboarding-state.ts) and
  `FULL_SEQUENCE` after `'model'`, before `'credentials'`
  (setup-flow-state.ts — draft fields already exist and persist). New
  `runMemoryStep(draft)` in setup-flow-core-steps.ts: `p.confirm` "Enable
  memory?" (default yes); if yes, `p.confirm` "Enable semantic search?
  Requires an OpenAI API key for embeddings" (default no). Dreaming stays a
  silent default. Dispatch branch in setup-flow.ts.
- Re-runnable setup: `apps/core/src/cli/index.ts` `runSetupCommand` — replace the inline
  step union (lists `credentials` before `model`; wrong order) with the
  `OnboardingStep` import. When state is `completed` OR settings.yaml exists
  with no state: `p.select` "What do you want to change?" → Run full setup /
  Chat channel / Model provider / Memory / Model credentials / Storage /
  Verify only / Cancel; targeted entries seed an in-progress state at that
  step and the existing loop runs forward to `ready` (pre-filled steps are
  fast). `restoreDraft` additionally seeds `telegramChatJid`/`slackChatJid`
  from the existing binding found by `resolveReadySummary`.
- Terminology (copy only): channel step "Choose your first provider" →
  "Choose your chat channel"; model step "Choose main model/provider" →
  "Choose your main chat model"; verify-step "in the Provider step" → "in
  the Chat channel step".
- Beautification (one choke point — the setup-flow.ts dispatch loop):
  before each step print `Step N/M · <Label> — <purpose>` (visible sequence
  = FULL_SEQUENCE minus skipped/welcome/ready); after a step returns `next`
  print a one-line dim recap (`✓ Model: opus (Anthropic)`) from a small
  `stepRecap(step, draft)` map in the same file. @clack/prompts only.
- Acceptance: setup-flow-simplified minimum-path test updated for the new
  sequence + back/forward traversal across model→memory→credentials;
  `runMemoryStep` unit test; `runSetupCommand` menu test.

### Stage 4 — Live provider key verification

- New `model-credential-verify.ts` (new file in `apps/core/src/cli`):
  `verifyModelProviderCredentialLive({providerId, authMode, payload,
  timeoutMs=10000})` → `{ok} | {ok:false, message} | {skipped, reason}`.
  Reuse `resolveGatewayUpstream` + `injectProviderAuth` from
  `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.ts`.
  Probes: default `GET {origin}{pathPrefix}/models` (openai + all
  OpenAI-compatible); anthropic api_key `GET /v1/models`; openrouter
  `GET /api/v1/key`. Skip-only v1: anthropic claude_code_oauth, bedrock,
  vertex. Plain `fetch` + `AbortSignal.timeout`. 401/403 → fail with
  upstream error body; network error → soft-fail (offer skip).
- Wire into: setup credentials step (verify before store; on fail: Re-enter /
  Store anyway / Back / Resume), `credentials model set` AND `rotate`
  (rotate merges partial payload, then verifies merged),
  `inspectModelCredentialReadiness(..., {live?})` (decrypt via
  `ModelCredentialService.getActiveCredential`, parallel checks, downgrade
  to fail with nextAction), `runDoctorWithNetwork` passes `{live:true}`.
- Doctor also gains a Slack live token check next to the existing
  Telegram one, reusing `validateSlackBotToken`/`validateSlackAppToken`
  from cli/slack.ts.
- Acceptance: mocked-fetch unit tests (pass, 401 with upstream message,
  timeout soft-fail, skip-only providers); re-prompt loop + explicit-skip
  tests; doctor live downgrade on 401 + Slack check.

### Stage 5 — Minimal multi-agent slice

- "Add another agent" entry in the Stage 3 menu: agent name → model select
  (reuse model-select machinery, `resolveModelSelectionForWorkload`) →
  `ensureConfiguredAgent` + `agents.<id>.model` via
  `writeDesiredRuntimeSettings` → if the provider lacks a credential, run
  the Stage 4 credential prompt + live verify → hand off to the existing
  provider connect flow (per-account `agentId` already supported).
- `gantry model set chat <alias> --agent <id>` writes `agents.<id>.model`
  (validated against the chat workload); `gantry model status` shows a
  per-agent overrides section when present.
- Acceptance: unit test for the `--agent` write path; menu test for the
  add-agent path.

### Stage 6 — Surface restart-required changes + management hygiene

- `apps/core/src/config/settings/desired-settings-writer.ts`: return the
  `classifySettingsChanges` classification (already computed in the import
  path — thread it out) as `{reconciled, restartRequired: string[]}`.
  A small shared helper prints, from every mutating CLI caller
  (memory.ts, model.ts reset memory, provider.ts, telegram-connect.ts,
  slack.ts, onboarding re-runs): "This change requires a restart to take
  effect — run `gantry restart`."
- `apps/core/src/cli/group.ts` `runName`: delete the contradictory "Restart Gantry" line
  (`agent_defaults` is live-applied).
- Help hygiene: `apps/core/src/cli/index.ts` top-level help — `credentials capability` →
  `credentials access`; surface the missing `agent`/`provider account`
  entries or point at the sub-help (pick the smaller diff).
- `gantry start` outro states it runs in the foreground and how to use the
  background service.
- Doctor invalid-channel-token nextAction: "re-run `gantry provider connect
  <channel>`, then `gantry restart`".
- Acceptance: writer classification unit test; one restartRequired command
  prints the line (memory dreaming), one liveApplied command does not
  (agent name); help shows `access`, not `capability`.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Settings writes no longer false-positive the stale guard; memory defaults derive from chat provider. |
| `settings.yaml` | Changed shape usage | No schema change; `memory.llm.models` values now provider-derived; `agents.<id>.model` written by new flows. |
| Postgres/runtime projection | Unchanged by design | No migrations; model credentials table reused as-is. |
| Control API | Changed | `/models` GET/PATCH drop `preset` for `provider`/`provider-managed`; openapi updated. |
| CLI | Changed | `model use-preset` deleted; `--agent` flag; live verify on credentials set/rotate; restart-required lines; help fixes; setup menu. |
| Wizard | Changed | Memory step, step headers/recaps, terminology, jump-to-step re-run. |
| Gantry MCP tools/admin | Unchanged by design | register_agent etc. remain the agent-facing surface. |
| Channel/provider adapters | Unchanged by design | Token flows keep existing connect machinery; doctor adds Slack live check only. |
| Docs/prompts | Changed | This goal prompt; help text; follow-ups documented here. |
| Tests/verification | Changed | Per-stage acceptance tests above. |

## Focused Verification (per stage)

```bash
npm run test:unit -- apps/core/test/unit/cli/
npm run test:unit -- apps/core/test/unit/config/
python3 .codex/scripts/check_architecture.py
```

Closeout pipeline (after the final stage, and after any stage that touches
shared settings paths):

```bash
npm run build
npm test
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
```

Use disposable Postgres for DB-backed tests — never the developer's
persistent database.

Runtime smoke: fresh `GANTRY_HOME=$(mktemp -d)` setup walk (OpenRouter model
→ memory yes/embeddings yes → bad key rejected by live verify → good keys →
Telegram → "Create Runtime" succeeds → verify → ready with step headers and
recaps visible); re-run menu → switch model provider → memory defaults
re-derive; `gantry memory dreaming on` prints the restart line;
`gantry agent name X` does not.

## Assumptions

- Known pre-existing red on main (not regressions): jobs-runs-memory-flow
  integration, runtime-setup-doctor e2e, live-admission integration tests,
  agent-runner-ipc NO_PROXY/heartbeat flakes under load.
- Embeddings remain OpenAI-or-disabled in v1 (`EmbeddingProviderName` is
  free-form but only an OpenAI client exists).
- Old onboarding-state files carrying `modelPreset` are ignored harmlessly
  (`readOnboardingState` doesn't validate data fields).
- Opus (default setup model) does not support memory workloads — that is
  exactly why memory defaults must derive per-provider, never "memory =
  chat model".
