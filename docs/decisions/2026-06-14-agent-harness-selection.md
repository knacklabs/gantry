# Agent Harness Selection

> **Status: accepted (2026-06-14).**
> This decision supersedes the 2026-06-13 provider-derived-only decision in
> `docs/decisions/2026-06-12-agent-engine-selection.md`. That older decision is
> now historical context for how `auto` behaves, not the active public contract.

> **Implementation status (2026-06-15): public harness slice live.**
> `agentHarness` / `agent_harness` is now the public selector across
> settings/API/CLI/contracts. Remaining DeepAgents parity work is listed below.

## Context

Gantry needs DeepAgents to be a first-class harness while preserving the safe
Claude-native path that only the Anthropic Claude Agent SDK can provide for
Claude OAuth/subscription credentials. The 2026-06-13 provider-derived-only
decision removed user choice to avoid impossible model/engine pairings. The new
product requirement is to restore user intent explicitly, but under a safer noun
and with a compatibility gate that fails before runner spawn.

## Decision

The durable public user intent is **agent harness**, not agent engine.

- Public API/SDK field: `agentHarness`.
- `settings.yaml` key: `agent_harness`.
- Allowed values: `auto`, `anthropic_sdk`, `deepagents`.
- Settings shape: `defaults.agent_harness` for newly configured agents and
  `agents.<id>.agent_harness` for per-agent selection.
- `auto` preserves the provider-derived behavior from the 2026-06-13 decision:
  Claude/Anthropic-provider models resolve to `anthropic_sdk`, while
  OpenAI/OpenRouter/future OpenAI-compatible providers resolve to `deepagents`.
- Explicit `anthropic_sdk` and `deepagents` selections are validated against the
  resolved model/provider/credential mode before runner spawn. Incompatible
  combinations fail closed and are never silently re-routed to another harness.
- Claude OAuth/subscription credentials are Anthropic-SDK-only.
- `executionProviderId` remains internal/read-only diagnostic.
- Internal runtime/audit diagnostics may still use `agent_engine`; it is not a
  public settings/API/CLI/SDK selector or response field.

This is the accepted strategy. The public settings/API/CLI/contracts slice has
landed; full DeepAgents parity is incomplete until reviewed Gantry MCP/admin
settings writes, job inheritance, DeepAgents delegation wrapper, Gantry
filesystem facades, skill/MCP projection, host-enforced evidence receipts, and
cleanup/full verification gates land together.

### Current Implementation Boundary

As of 2026-06-15:

- `agent_harness` and writable `agentHarness` are live public settings/API/CLI
  contract.
- `agentEngine` must not be reintroduced as a public selector or read field.
- Jobs and conversations do not have their own harness selector in either the
  current implementation or the accepted target strategy.
- DeepAgents parity must not be claimed until the blockers in this decision and
  the handoff plan are resolved.

Known blockers before full parity can be claimed:

- reviewed Gantry MCP/admin settings tools for `agentHarness` writes;
- credential/sandbox compatibility rejection before runner spawn;
- job inheritance through the same resolver;
- DeepAgents delegation wrapper for `AgentDelegation`, with raw `task` and
  `write_todos` hidden until covered;
- Gantry filesystem facades for file search/read/edit/write, with protected-path
  checks, symlink canonicalization, sandbox enforcement, audit, and changed-file
  evidence;
- skill projection by reviewed skill ids/versions and scoped subagent tools;
- stdio MCP fail-closed behavior, proxy/egress projection, and sandboxed
  adapter execution for DeepAgents-visible MCP tools;
- host-enforced evidence receipts, not model-only formatting guidance;
- cleanup searches and full gates proving stale writable `agentEngine`,
  provider-native authority, raw DeepAgents tools, and old selector paths are
  absent from active surfaces.

### Setup UX Contract

Setup and agent editing surfaces must expose exactly these choices:

| Option        | Value           | Description                                                                                                           |
| ------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Auto          | `auto`          | Gantry chooses the safest compatible harness for the selected model.                                                  |
| Anthropic SDK | `anthropic_sdk` | Use the Claude Agent SDK for Claude-native execution.                                                                 |
| DeepAgents    | `deepagents`    | Use DeepAgents for advanced planning, skills, filesystem workflows, and internal delegation under Gantry permissions. |

Locked invalid copy:

- `Model <alias> cannot run on <harness>. Choose Auto or a compatible model.`
- `DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.`

Implementation receipts for this plan use exactly this format:

```text
Completed: <short outcome>
Used: <tools/capabilities>
Changed: <files/accounts/channels or none>
Delegated: yes/no
Needs attention: <blocker or none>
```

### DeepAgents Subagents

DeepAgents subagents are internal execution primitives only. They map to Gantry
`AgentDelegation` for runtime tracing, ownership, fencing, and audit. They are
not user-managed agents, not durable public agent definitions, and not a user
dashboard, mission-control, or subagent-management surface.

### Gantry-Owned Authority

Gantry owns filesystem, skills, MCP, Browser, permissions, sandbox, egress,
memory boundary, audit, storage, and credentials. Raw `execute`, raw local FS,
raw `.mcp.json`, raw provider credentials, and model-created durable subagents
remain impossible.

## Target Surface Impact Matrix

The matrix below describes the accepted implementation target, not the current
live repo state. Surfaces marked `Changed` remain pending until their
corresponding implementation slice is merged and verified.

| Surface                      | Impact               | Reason                                                                                                                                                                |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------- |
| Runtime behavior             | Changed              | Run admission resolves `agentHarness + modelAlias + credential mode` into the internal execution route; explicit incompatible harnesses fail before runner spawn.     |
| `settings.yaml`              | Changed              | Adds `defaults.agent_harness` and `agents.<id>.agent_harness` as non-secret desired-state fields; `auto` is the default.                                              |
| Postgres/runtime projection  | Changed              | Runtime projection may carry selected `agentHarness` and resolved diagnostics, but settings remain durable authority.                                                 |
| Control API                  | Changed              | Agent reads/writes expose `agentHarness`; `executionProviderId` remains internal/read-only diagnostic where route diagnostics already exist.                          |
| SDK/contracts                | Changed              | Contracts expose `AgentHarness = auto                                                                                                                                 | anthropic_sdk | deepagents`; public `agentEngine` is removed. |
| CLI                          | Changed              | Agent configuration commands expose `agent_harness`; model/status/why surfaces show selected `agentHarness`.                                                          |
| Gantry MCP tools/admin skill | Changed              | Reviewed settings desired-state updates may request `agent_harness`; admin tools never grant raw provider or filesystem authority.                                    |
| Channel adapters             | Read-only/observable | Slack, Teams, Telegram, WhatsApp, Web, and App channels render the same approvals/receipts and gain no channel-specific authority.                                    |
| LLM/provider adapters        | Changed              | DeepAgents harness support changes model-gateway routing, MCP projection, credential projection, and adapter admission while keeping raw provider credentials hidden. |
| Docs/prompts                 | Changed              | Architecture, credential, setup, and decision docs must use `agentHarness` for user intent and keep older `agentEngine` selector text historical.                     |
| Audit/events                 | Changed              | Audit records may include selected `agentHarness`, internal `agent_engine`, credential mode without secrets, and `executionProviderId` as diagnostic evidence.        |
| Tests/verification           | Changed              | Unit, contract, integration, and cleanup-search coverage must prove settings/API/CLI/MCP writes, compatibility rejection, diagnostics, and authority boundaries.      |

## Acceptance Criteria

These are cutover acceptance criteria. They are not evidence that the current
implementation already satisfies the target contract.

1. Settings validation accepts `auto`, `anthropic_sdk`, and `deepagents` for
   `defaults.agent_harness` and `agents.<id>.agent_harness`, defaults missing
   values to `auto`, and rejects old writable `agent_engine` settings outside
   historical docs/tests.
2. API, SDK, CLI, setup, and reviewed Gantry MCP/admin settings paths can set
   `agentHarness`; all of them update `settings.yaml` as durable desired state
   rather than making Postgres the only source of truth.
3. Agent read/status/model-why responses show selected `agentHarness` and
   internal/read-only `executionProviderId` where diagnostics already expose
   execution routing.
4. `auto` resolves exactly like the 2026-06-13 provider-derived behavior.
5. Explicit `anthropic_sdk` and `deepagents` fail closed before runner spawn
   when the resolved model/provider/credential mode is incompatible, using the
   locked invalid copy above.
6. DeepAgents with Claude OAuth/subscription credentials always fails closed
   with the locked credential copy above; Claude OAuth/subscription never reaches
   DeepAgents.
7. DeepAgents subagent execution is observable only through Gantry
   `AgentDelegation`; no new user-managed subagent dashboard, durable subagent
   definition, or mission-control surface exists.
8. Gantry-owned filesystem, skills, MCP, Browser, permissions, sandbox, egress,
   memory boundary, audit, storage, and credential controls remain the only
   authority surfaces for DeepAgents.

## Test Plan

- Add schema/contract unit tests in `packages/contracts/test/unit/index.test.ts`
  for `AgentHarness`, `agentHarness` writes, and read-only
  `agentEngine`/`executionProviderId`.
- Add settings parse/render/import/export tests in
  `apps/core/test/unit/config/runtime-settings.test.ts`,
  `apps/core/test/unit/config/settings-import-service.test.ts`,
  `apps/core/test/unit/config/settings-desired-state-service.test.ts`, and
  `apps/core/test/unit/config/desired-settings-writer.test.ts` for
  `defaults.agent_harness` and `agents.<id>.agent_harness`.
- Add resolver tests for `auto`, explicit-compatible, explicit-incompatible,
  and Claude OAuth/subscription with DeepAgents.
- Add Control API agent write tests in
  `apps/core/test/unit/control/server-auth.test.ts`,
  `apps/core/test/unit/control/openapi.test.ts`,
  `apps/core/test/unit/control/agent-profile-routes.test.ts`, and
  `apps/core/test/unit/control/model-agent-preview.test.ts` proving
  `POST /v1/agents`, `PATCH /v1/agents/:id`, and model preview handle
  `agentHarness` correctly.
- Add setup/CLI tests in
  `apps/core/test/unit/cli/setup-flow-model-step.test.ts`,
  `apps/core/test/unit/cli/group-engine.test.ts`,
  `apps/core/test/unit/cli/model-preview-format.test.ts`, and
  `apps/core/test/unit/cli/model-command.test.ts` proving setup, agent
  list/info, model preview/why, and model commands expose harness only through
  the target surface.
- Add Gantry MCP/admin settings tests in
  `apps/core/test/unit/jobs/ipc-runtime-admin-handlers.test.ts`,
  `apps/core/test/unit/runner/agent-capabilities.test.ts`, and
  `apps/core/test/unit/runner/mcp/server-registry.test.ts` proving
  `settings_desired_state` and `request_settings_update` route harness changes
  through reviewed settings writes.
- Add runner/admission tests proving incompatible explicit harnesses reject
  before runner spawn.
- Add DeepAgents authority tests proving raw `execute`, raw local FS, raw
  `.mcp.json`, raw provider credentials, and model-created durable subagents are
  impossible.

Focused commands for the implementation slice:

```bash
npm run test:unit -- packages/contracts/test/unit/index.test.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/settings-import-service.test.ts apps/core/test/unit/config/settings-desired-state-service.test.ts apps/core/test/unit/config/desired-settings-writer.test.ts apps/core/test/unit/control/server-auth.test.ts apps/core/test/unit/control/openapi.test.ts apps/core/test/unit/control/agent-profile-routes.test.ts apps/core/test/unit/control/model-agent-preview.test.ts apps/core/test/unit/cli/setup-flow-model-step.test.ts apps/core/test/unit/cli/group-engine.test.ts apps/core/test/unit/cli/model-preview-format.test.ts apps/core/test/unit/cli/model-command.test.ts apps/core/test/unit/jobs/ipc-runtime-admin-handlers.test.ts apps/core/test/unit/runner/agent-capabilities.test.ts apps/core/test/unit/runner/mcp/server-registry.test.ts
npm run test:unit -- apps/core/test/unit/core/model-provider-registry.test.ts apps/core/test/unit/models/model-catalog.test.ts apps/core/test/unit/adapters/deepagents-credential-validation.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts
npm run typecheck
npm run build
python3 .codex/scripts/check_architecture.py
```

Full phase closeout:

```bash
npm test
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
```

## Cleanup Plan

Before cutover is complete, run cleanup searches and classify every remaining
match as active, rejected-only, generated, or historical decision context:

```bash
rg -n "defaults\.agent_engine|agents\.<id>\.agent_engine|agent_engine|gantry agent engine|AGENT_ENGINE_CHANGED|MEMORY_ENGINE_CHANGED|memory\.engine" apps/core/src apps/core/test docs
rg -n "provider-derived engine|provider-derived-only|Retired user-facing selectors|agentHarness|agent_harness" docs apps/core/src apps/core/test
rg -n "raw execute|LocalShellBackend|FilesystemBackend|\.mcp\.json|model-created durable subagents|mission control|dashboard" apps/core/src apps/core/test docs
```

Expected cleanup interpretation:

- `agent_engine` may remain in run diagnostics, historical ADRs, database
  column names that are diagnostic-only, and tests that prove old writable
  settings are rejected.
- `agentEngine` must not remain in active public settings/API/CLI/SDK docs or
  contracts.
- `defaults.agent_engine`, `agents.<id>.agent_engine`, `gantry agent engine`,
  writable/read API/SDK `agentEngine`, and model-created durable subagent
  authority must not remain as active public contract.

## Alternatives Considered

- Keep the 2026-06-13 provider-derived-only design. Rejected because it cannot
  express the new user requirement to choose a first-class DeepAgents harness.
- Reuse writable `agentEngine`. Rejected because `agentEngine` is now the
  effective diagnostic after resolution, and reusing it would blur intent with
  runtime outcome.
- Add a user-managed DeepAgents subagent surface. Rejected because Gantry agents
  and delegation are the durable product concepts; DeepAgents subagents are
  provider/runtime execution primitives.

## Rollback Or Migration Notes

This is a clean-cut pre-user contract change. Implementation should replace
old writable `agent_engine` settings and API/CLI/MCP writes with
`agent_harness`; do not add migration shims or compatibility branches for old
local state. If a checkout still contains old local settings, validation should
fail with a direct cleanup instruction rather than silently remapping.
