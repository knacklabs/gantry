# Goal Prompt: Inline Agent Feature Parity (Phase 2)

## Objective

Expose the capabilities the underlying stacks (claude-agent-sdk, deepagents/langgraph, Gantry Model Gateway) already provide but the v1 inline runtime does not surface. Four stages, ordered by value-per-risk. Builds directly on the lightweight-agent-modes work (see `docs/architecture/lightweight-agent-modes-goal-prompt.md`); the worker runtime stays untouched.

Use ponytail. Keep changes surgical. No compatibility shims. Reuse the canonical seams from phase 1: the loop-lane input contract, the core-tools registry, the settings reader, and the inline admission rules.

## Grounding (verified against code and installed packages)

- Claude lane (`apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts`) calls claude-agent-sdk `query()` without `maxTurns` or `effort`; both exist in the installed SDK's options.
- DeepAgents lane (`apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts`) calls `createDeepAgent` without `responseFormat` and invokes without `recursionLimit`; the installed deepagents package exports `SupportedResponseFormat`, `createSkillsMiddleware`, `listSkills`, `createSummarizationMiddleware`, and `createAgentMemoryMiddleware`.
- An in-memory (disk-less) skill projection already exists for the worker deepagents runner: `apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts`.
- Inline memory today is a prompt block (`memoryContextBlock`) threaded through `apps/core/src/runtime/agent-inline.ts`.
- Inline runtime settings live in `apps/core/src/config/settings/runtime-settings-agent-runtime.ts` (reader-versioned).

## Stage A — Iteration and effort knobs

1. Add optional per-agent settings under the agent entry: `max_turns` (positive int, default unset) and `effort` (`low|medium|high|xhigh|max`, default unset), parsed/validated in the settings stack alongside the existing `runtime` field (reader version bump).
2. Thread both through the inline execution shell (`agent-inline.ts`) into the loop-lane input.
3. Claude lane maps `max_turns` → `maxTurns` and `effort` → `effort` on `query()` options. DeepAgents lane maps `max_turns` → `recursionLimit` on the run config (document the semantic difference: SDK turns vs graph steps).
4. Default when unset: apply a conservative built-in cap (constant, e.g. 50) so inline loops are turn-bounded, not only timeout-bounded. Hitting the cap must produce a clear terminal error naming the cap, not a silent stop.

Acceptance: unit tests prove the mapping per lane, the default cap applies when unset, an over-cap loop terminates with the named error, and settings validation rejects bad values.

## Stage B — Structured output for inline turns

1. Accept an optional JSON schema on the sessions message API (`apps/core/src/control/server/routes/sessions.ts` message-send payload, additive field, e.g. `response_schema`), threaded through live-turn plumbing to the loop-lane input.
2. DeepAgents lane: pass it as `responseFormat` (provider-native where supported, tool-strategy otherwise — deepagents decides). Claude lane: implement via a strict-mode answer tool (schema as `input_schema`, `strict: true`) whose call terminates the turn with the validated payload.
3. The final `AgentOutput.result` carries the validated JSON (string-encoded, additive field for the parsed form if the existing contract requires) so SDK consumers get typed replies.
4. Document in `docs/architecture/capability-management.md` next to the /llm/v1 section: direct LLM callers use provider-native strict schema via passthrough; inline agents use `response_schema`.

Acceptance: integration case in the existing inline suite (`apps/core/test/integration/inline-agent-runtime.integration.test.ts`) drives a turn with a schema on both lanes (mocked models) and asserts schema-valid output; invalid model output surfaces as a shaped error, not a crash.

## Stage C — Inline skills (deepagents lane first)

1. Reuse the existing in-memory projection (`apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts`) to feed `createSkillsMiddleware` in the deepagents inline lane — no disk writes, respecting the deny-all filesystem permissions already configured.
2. Relax the inline admission hard-reject: skills become inline-compatible for deepagents-engine agents only; Claude-engine inline agents still reject skills (their SDK skill loading is file-based) — keep the error message naming the engine constraint.
3. Skill content resolution goes through the same skills repository the worker projection uses; no new storage.

Acceptance: an inline deepagents agent with an attached skill loads it (unit: middleware receives the projected skill; integration: skill-influenced response with mocked model); a Claude-engine inline agent with a skill still hard-rejects with the engine-specific message.

## Stage D — Long-session hygiene (compaction + memory bridge)

1. DeepAgents lane: wire `createSummarizationMiddleware` with defaults derived from the model's context window (deepagents exports `computeSummarizationDefaults`) so long inline sessions compact instead of overflowing.
2. Claude lane: verify long-session behavior (the SDK self-manages context); add a regression test that a session exceeding the mock context threshold continues rather than erroring. Only add code if the test proves a real gap.
3. Memory bridge: replace the one-shot `memoryContextBlock` injection in the deepagents lane with `createAgentMemoryMiddleware` backed by a thin adapter over Gantry's existing memory application services (same services the core-tools memory handlers use — reuse, don't duplicate). Claude lane keeps prompt-block injection in this phase.

Acceptance: unit tests for the middleware wiring and the memory adapter delegating to the existing service; integration case proving a compacted session retains task continuity (mocked model).

## Non-goals

Out of scope for this goal and not planned: deepagents async/library-internal subagents (delegation stays on Gantry task-lifecycle), `StoreBackend`, sandbox backends, and harness profiles. Claude-lane skills are excluded by the engine constraint documented in Stage C.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Turn caps, structured output, skills (deepagents inline), compaction, memory middleware. |
| `settings.yaml` | Additive | `max_turns`, `effort` per agent; reader version bump. Skills admission relaxed for deepagents-engine inline agents. |
| Control API | Additive | `response_schema` on session message send; OpenAPI updated. |
| SDK/contracts | Additive | New optional request field + structured result field. |
| Postgres | Unchanged | No schema change. |
| Gantry MCP tools | Unchanged | Core-tools registry untouched. |
| Channel adapters | Unchanged | Event contract unchanged. |
| Docs | Changed | capability-management runtime-tier section gains the new knobs. |
| Tests | Changed | Per-stage coverage listed above. |

## Focused Verification

```bash
npm run build
npm test
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/verify.py
```

Postgres-backed integration runs use disposable Postgres (same flow as phase 1). Event-parity snapshot must stay green — none of these stages may alter the live-turn event sequence.

## Runtime Smoke

Build + `launchctl kickstart -k gui/$(id -u)/com.gantry` + `gantry status`. Then: one inline deepagents turn with a `response_schema` returning valid JSON; one inline agent with `max_turns: 2` observably capping; one skill-attached inline deepagents turn. Knacklabs lead-gen job to successful terminal result.

## PR Closeout

Same contract as phase 1: staged-only goal files, pipeline evidence section (implementation summary, verification results, smoke evidence, autoreview clean result, risks). One PR for the phase; stages land as sequential commits.

## Bounded Write Scope

- `apps/core/src/config/settings/**` (knob parsing/validation + reader version)
- `apps/core/src/runtime/agent-inline.ts`, `apps/core/src/runtime/agent-spawn-admission.ts`, `apps/core/src/shared/agent-runtime.ts` (knob threading + skills admission relaxation)
- `apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/**`, `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/**`, `apps/core/src/adapters/llm/inline-lane-dispatcher.ts`
- `apps/core/src/control/server/routes/sessions.ts` + OpenAPI route files (response_schema field)
- Memory adapter: new module beside the deepagents inline lane, delegating to existing application memory services
- Tests + docs for the above. Nothing else.
