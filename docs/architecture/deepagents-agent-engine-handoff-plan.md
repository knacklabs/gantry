# DeepAgents Full-Parity Agent Harness Plan

Status: ENG-124 accepted target handoff plan, updated 2026-06-15 to distinguish
target strategy from current implementation. The product decision is that
DeepAgents should become a first-class Gantry execution harness. This document
is the active handoff plan for that target. It is not evidence that the target is
fully implemented, and it is not superseded by the older provider-derived-only
engine model.

Current implementation boundary:

- The active repo still derives the read-only `agentEngine` from the selected
  model provider.
- The current `settings.yaml` parser/API do not yet accept
  `agent_harness`/`agentHarness` writes.
- `agentHarness` is the accepted target user-intent field, not a currently live
  write surface.
- `agentEngine` remains read-only diagnostic output and must not become a
  writable public selector.
- Jobs and conversations inherit the bound agent's target harness in this plan;
  no current or planned job-level/conversation-level harness selector exists.

## Summary

Gantry exposes one durable public harness choice on agents:

- API/SDK field: `agentHarness`
- `settings.yaml` key: `agent_harness`
- valid values: `auto`, `anthropic_sdk`, `deepagents`

`auto` preserves the current provider-derived behavior. Claude/Anthropic-provider
models resolve to the Anthropic SDK lane, and OpenAI-compatible provider routes
resolve to the DeepAgents lane. Explicit `anthropic_sdk` or `deepagents` forces
the requested harness when the selected `modelAlias`, credential mode, sandbox,
and capability projection are compatible. Invalid combinations fail before
runner spawn.

In the target contract, `agentEngine` remains an effective read-only diagnostic derived from
`agentHarness + modelAlias + model route`. It reports the harness that will
actually run after `auto` is resolved. `executionProviderId` remains
internal/read-only diagnostic detail. Public configuration, SDK writes, CLI
writes, jobs, and MCP/admin-tool requests must not persist or accept
`executionProviderId`.

Claude OAuth/subscription credentials are Anthropic-SDK-only. DeepAgents uses
brokered Model Access through Gantry's model gateway and may receive only
run-scoped gateway credentials for supported API-key/provider routes.

DeepAgents subagents are internal execution primitives, not user-managed workers.
There is no user dashboard, user-managed worker list, or mission-control UI for
subagents. Users see approval prompts, the final answer, the evidence receipt,
and audit/runtime detail.

Full parity is blocked until all of these implementation slices are complete:

- public harness contract across `settings.yaml`, Control API, SDK, CLI, and
  reviewed Gantry MCP/admin tools;
- resolver/admission for `agentHarness + modelAlias + credential mode + sandbox`
  before runner spawn;
- jobs and live turns using the same inheritance/resolution path;
- DeepAgents delegation wrapper that maps `AgentDelegation` to raw `task` only
  after Gantry policy approval;
- Gantry file facades for `FileSearch`, `FileRead`, `FileEdit`, and
  `FileWrite`, including protected paths, symlink checks, sandbox enforcement,
  audit, and receipt evidence;
- skills projected by reviewed ids/versions with scoped subagent tool sets;
- stdio MCP fail-closed behavior, proxy/egress projection, and sandboxed MCP
  adapter execution before DeepAgents-visible MCP tools are enabled;
- host-enforced evidence receipts for final responses instead of relying on
  model-only formatting;
- cleanup searches and full gates proving stale writable `agentEngine`, raw
  provider authority, raw DeepAgents tools, and old selector paths are absent
  from active surfaces.

## Exact UX Contract

This is the target UX contract. The option labels, values, descriptions, and
receipt lines are locked for implementation, but the current parser/API do not
yet accept the `agent_harness` key.

Field label: `Execution harness`

Settings example:

```yaml
defaults:
  name: Default Agent
  model: opus
  agent_harness: auto

agents:
  main_agent:
    name: Default Agent
    model: opus
    agent_harness: deepagents
```

Options:

| Value | Label | Description |
| --- | --- | --- |
| `auto` | Auto | Gantry chooses the safest compatible harness for the selected model. |
| `anthropic_sdk` | Anthropic SDK | Use the Claude Agent SDK for Claude-native execution. |
| `deepagents` | DeepAgents | Use DeepAgents for advanced planning, skills, filesystem workflows, and internal delegation under Gantry permissions. |

Rules:

- `defaults.agent_harness` is the setup/default harness for agents that do not
  set their own harness.
- `agents.<id>.agent_harness` is the per-agent override.
- `agentHarness` is the public durable API/SDK field and mirrors the settings
  value.
- `agentEngine` is read-only effective diagnostic output, never a write field.
- `executionProviderId` is internal/read-only diagnostic output.
- Conversations and jobs inherit the bound agent's `agentHarness`; they do not
  get job-level or conversation-level harness selectors.
- Conversation model overrides and job model defaults may still choose
  `modelAlias`; they must not choose harness.
- Public APIs must not accept raw provider model ids, DeepAgents backend ids,
  Claude settings paths, provider-native tool names, or job-level harness fields.

Required user-visible result surfaces:

- Setup and agent settings show `Execution harness`.
- Agent list/detail show `agentHarness` plus the effective read-only
  `agentEngine`.
- Model preview/why output shows `modelAlias`, provider route, credential
  profile, `agentHarness`, effective `agentEngine`, and diagnostic
  `executionProviderId`.
- Runtime events, job run detail, and audit logs include the requested harness,
  effective engine, and diagnostic provider id without exposing secrets.

Required error copy:

- Unsupported harness: `Unsupported execution harness: <value>. Choose auto, anthropic_sdk, or deepagents.`
- Unsupported model/harness pair: `Model <alias> cannot run on <harness>. Choose Auto or a compatible model.`
- OpenAI-compatible route with Anthropic SDK: `Model <alias> uses an OpenAI-compatible route, which is not supported by Anthropic SDK. Choose Auto, DeepAgents, or an Anthropic-compatible model.`
- Claude OAuth with DeepAgents: `DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.`
- Missing credential: `Setup required: configure <provider> Model Access before using <alias> with <harness>.`
- Unsafe sandbox: `DeepAgents requires an enforcing sandbox before shell or filesystem tools can be enabled in this deployment mode.`
- Raw DeepAgents tool blocked: `DeepAgents raw tool authority is disabled. Use Gantry-approved tools or request the required capability.`

## Target User-Visible Evidence Receipt

Every DeepAgents final response that uses delegation, files, skills, MCP tools,
browser, shell, or other policy-gated authority must include an evidence receipt
in exactly this format:

```text
Completed: <short outcome>
Used: <tools/capabilities>
Changed: <files/accounts/channels or none>
Delegated: yes/no
Needs attention: <blocker or none>
```

Receipt rules:

- `Completed: <short outcome>` lists user-relevant outcomes, not internal graph steps.
- `Used: <tools/capabilities>` lists Gantry facade tools, selected capabilities, skill ids, MCP
  servers, browser, shell, model route, and file surfaces that materially
  affected the result.
- `Changed: <files/accounts/channels or none>` lists file, settings, artifact,
  account, channel, or external-system writes. If nothing changed, say `none`.
- `Delegated: yes/no` is `yes` when internal `AgentDelegation` calls ran and
  `no` otherwise.
  It must not expose raw DeepAgents tool names, raw prompts, hidden subagent ids,
  or provider-native implementation details.
- `Needs attention: <blocker or none>` lists denied approvals, missing setup,
  skipped work, unsafe sandbox blockers, unsupported routes, and verification
  gaps. If nothing needs attention, say `none`.

Implementation note: this receipt must be host-enforced before full parity is
claimed. A prompt-only or model-only instruction is not sufficient evidence.

## Target Harness Resolution

Resolution input:

- agent `agentHarness`
- selected `modelAlias`
- model catalog route and provider family
- credential profile and credential mode
- workload: interactive, job, memory, or delegation
- sandbox provider and tool/capability projection

Resolution output:

- effective `agentEngine`: `anthropic_sdk` or `deepagents`
- internal `executionProviderId`
- model gateway route
- credential projection plan
- sandbox/tool projection plan
- compatibility decision and user-facing error if rejected

Required behavior:

- `auto` preserves the existing provider-derived behavior.
- Explicit `anthropic_sdk` rejects OpenAI-compatible model routes before runner
  spawn.
- Explicit `deepagents` rejects unsupported model routes, unsupported credential
  modes, or unsafe tool/sandbox combinations before runner spawn.
- Claude OAuth/subscription credentials never reach the DeepAgents adapter.
- Raw provider credentials never reach tool subprocesses. DeepAgents receives
  only run-scoped loopback gateway env and selected non-secret runtime metadata.
- Jobs and live turns use the same harness resolver. Jobs inherit the bound
  agent's harness; no job-level harness override exists.

Current-state note: this resolver/admission path is pending. Existing runtime
behavior remains provider-derived/read-only as described in README and the SDK
and credential-management docs.

## Target DeepAgents Delegation Contract

DeepAgents `task` is re-enabled only behind a Gantry delegation wrapper mapped
to the durable `AgentDelegation` capability. Raw DeepAgents `task` is not
user-facing authority.

Wrapper requirements:

- The model sees a Gantry-owned delegation tool, not raw `task`.
- The wrapper evaluates `AgentDelegation` policy before invoking any DeepAgents
  subagent task.
- A denied delegation request returns a denial to the model and never invokes
  DeepAgents `task`.
- The wrapper records audit/runtime evidence with parent run id, delegate label,
  capability decision, selected subagent definition hash, selected tools, and
  terminal outcome.
- Raw DeepAgents tool names are adapter-private and must not appear in settings,
  public APIs, SDK authority, CLI authority, persistent capabilities, or user
  approval prompts.
- Until the wrapper lands, the adapter keeps stripping `task` and `write_todos`
  from the model-visible tool list.

## Internal Subagents

Subagent definitions are host-resolved. The model may request delegation through
the wrapper, but it cannot create durable subagent identities, save new subagent
profiles, attach new skills, widen permissions, or persist worker state.

Subagent inheritance boundaries:

- Harness: subagents inherit the parent run's effective `agentEngine`; they do
  not select their own `agentHarness`.
- Model: subagents inherit the parent run model by default. Any host-defined
  override must resolve through the same model catalog and remain on the parent
  provider backend. Cross-provider work belongs in a separate session or job.
- Prompt/persona: subagents receive a host-resolved role prompt plus the
  delegated task brief. They do not mutate the parent agent profile.
- Tools: subagent tools replace the parent tool set. They never merge with parent
  tools by default. A parent capability is available to a subagent only when the
  host repeats it in that subagent's resolved tool scope.
- Skills: subagents receive only reviewed skill ids and versions selected for
  that subagent scope.
- Memory: subagents may receive scoped prompt context selected by Gantry, but
  they do not write durable memory as a separate durable identity.
- Permissions: subagent tool calls pass through the same Gantry policy,
  protected-path, sandbox, egress, and audit gates. Parent transient grants do
  not become durable subagent authority.

User-facing UX:

- No user-managed worker roster.
- No mission-control UI for subagents.
- No editable subagent dashboard in this plan.
- Users see approvals, final answer, evidence receipt, and audit/runtime detail.

## Filesystem Contract

DeepAgents filesystem access must go through Gantry facade tools only:

- `FileSearch`
- `FileRead`
- `FileEdit`
- `FileWrite`

Required constraints:

- Do not expose DeepAgents raw filesystem tools (`ls`, `read_file`,
  `write_file`, `edit_file`, `glob`, `grep`) as durable authority.
- Do not enable raw DeepAgents filesystem backends for Gantry file authority.
- Resolve and validate paths through Gantry before open/write.
- Canonicalize symlinks before policy decisions; deny symlink escapes.
- Enforce protected read/write path policy before filesystem access.
- Require an enforcing sandbox for production/remote DeepAgents file writes and
  any run that combines file authority with shell/local CLI authority.
- Audit every file read/write/edit/search decision with the Gantry facade tool
  name, normalized path or artifact id, policy decision, sandbox provider,
  parent run id, and delegated subagent context when present.
- File write/edit tools must produce durable changed-file evidence for the final
  receipt.

Current-state note: this plan does not claim raw DeepAgents filesystem parity.
Full parity requires Gantry facades, sandbox enforcement, protected-path checks,
audit, and receipt evidence to be implemented and verified first.

## Skills And Capability Projection

Skills remain reviewed Gantry capabilities and sources. A skill attachment is
not execution authority by itself.

Required behavior:

- Project skills from reviewed skill ids and immutable versions, not display
  labels.
- Subagent scopes must list the exact skill ids and versions projected to that
  subagent.
- Skill prompt files may guide behavior but must not grant credentials, shell,
  filesystem, browser, MCP, or external API access by attachment alone.
- Skill-owned credentials come only from Credential Center bindings approved for
  that capability/scope.
- Skill-owned commands require reviewed local CLI or scoped `RunCommand(...)`
  authority. They are not implied by skill attachment.
- Runtime skill materialization remains scratch projection; durable reviewed
  history stays in Gantry artifacts/storage.

## MCP, Egress, And Sandbox Blockers

DeepAgents-visible MCP tools are blocked until Gantry can project them through
fail-closed host control:

- stdio MCP servers must fail closed when the approved server definition,
  credential binding, sandbox profile, or proxy/egress projection is missing;
- raw `.mcp.json` authority and provider-native MCP tool names remain
  adapter-private and must not become durable user or agent authority;
- approved MCP stdio subprocesses must receive only the Gantry-owned sandbox,
  brokered egress/proxy environment, and credential projection needed for that
  server;
- denied, stale, or unbound MCP requests must return a Gantry denial and record
  audit/runtime evidence before any provider-visible tool invocation.

## Target Surface Impact Matrix

The matrix below describes the target implementation. It must not be read as
current-state evidence until the matching work packets, cleanup searches, and
verification gates pass.

| Surface | Status | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Harness resolution becomes `agentHarness + modelAlias -> effective agentEngine + executionProviderId`, with DeepAgents accepted as a first-class explicit harness when compatible. |
| `settings.yaml` | Changed | Adds non-secret `defaults.agent_harness` and `agents.<id>.agent_harness`; settings remains desired state. |
| Postgres/runtime projection | Changed | Projects requested harness, effective engine, diagnostic provider id, and delegation/audit evidence into runtime state without making Postgres the durable settings source. |
| Control API | Changed | Agent read/write surfaces accept `agentHarness`, expose read-only `agentEngine`, and keep `executionProviderId` read-only diagnostic. |
| SDK/contracts | Changed | SDK types expose durable `agentHarness`, read-only effective `agentEngine`, compatibility errors, and evidence receipt shape. |
| CLI | Changed | Setup, agent list/show/update, model preview/why, and doctor surfaces use `Execution harness` and `agent_harness`. |
| Gantry MCP tools/admin skill | Changed | Settings/admin tools may request reviewed `agentHarness` updates; agents must not edit settings or DB directly. |
| Channel adapters | Read-only/observable | Slack, Teams, Telegram, WhatsApp, Web, and App channels render the same approvals/receipts and gain no channel-specific authority. |
| LLM/provider adapters | Changed | DeepAgents harness wiring changes model-gateway routing, MCP projection, credential projection, and adapter admission while keeping raw provider credentials hidden. |
| Docs/prompts | Changed | DeepAgents docs and prompts must use `agentHarness`/`agent_harness`, internal subagents, and Gantry facade authority. |
| Audit/events | Changed | Audit logs and runtime events include requested harness, effective engine, delegation, tools, approvals, sandbox, egress, and receipt evidence. |
| Tests/verification | Changed | Adds resolver, projection, delegation-wrapper, raw-authority denial, file facade, skills, job/live, audit, and receipt coverage. |

## Capability-Driven Work Packets

These packets are pending implementation slices unless a future closeout note
links to passing verification evidence.

1. Harness selection
   - Add public `agentHarness = 'auto' | 'anthropic_sdk' | 'deepagents'`.
   - Parse/render/import/export/project `agent_harness` defaults and per-agent
     overrides.
   - Expose writes through settings, Control API, SDK, CLI, and approved admin
     tools.
   - Keep `agentEngine` and `executionProviderId` read-only diagnostics.

2. Compatibility resolver
   - Resolve `agentHarness + modelAlias` into effective engine, model route,
     credential projection, sandbox requirements, and internal provider id.
   - Reject invalid combinations before runner spawn.
   - Preserve `auto` behavior exactly.

3. DeepAgents harness parity
   - Treat `deepagents:langchain` as a first-class `AgentExecutionAdapter`.
   - Preserve runner frame contracts, provider session evidence, usage/context
     accounting, job heartbeat, live continuation/stop behavior, and cache
     accounting.
   - Keep model credentials in the model lane and tool networking in the tool
     lane.

4. Delegation wrapper
   - Map Gantry `AgentDelegation` to DeepAgents `task`.
   - Deny without invoking `task` when policy rejects the request.
   - Keep raw `task` and `write_todos` hidden until the wrapper is implemented
     and tested.

5. File facade parity
   - Route file search/read/edit/write through Gantry facade tools only.
   - Enforce protected paths, symlink checks, sandbox, egress where relevant,
     audit, and final receipt evidence.

6. Skills and subagent scopes
   - Project reviewed skill ids and versions into parent and subagent scopes.
   - Ensure subagent tool scopes replace rather than merge with parent tools.
   - Keep credentials and commands gated by explicit approved capabilities.

7. Jobs, live turns, memory, and audit
   - Jobs inherit bound-agent harness.
   - Live turns keep durable owner routing for continuations, stop, stdin close,
     and pending interactions.
   - Gantry memory remains authoritative; DeepAgents memory is prompt context
     only unless a later reviewed design adds durable support.
   - Emit receipt/audit/runtime evidence for decisions and outcomes.

8. Docs and cleanup
   - Update docs/prompts that still describe provider-derived-only harness
     selection.
   - Remove old public-selector names from active docs and tests in the same
     implementation phase that introduces replacements.
   - Do not add compatibility aliases or local-only branches.

## Acceptance Criteria

These are cutover acceptance criteria for claiming full DeepAgents harness
parity.

- Settings can store `agent_harness: auto`, `anthropic_sdk`, or `deepagents` at
  defaults and per-agent scope.
- API/SDK use `agentHarness`; `settings.yaml` uses `agent_harness`.
- `auto` produces the same effective harness behavior as the current
  provider-derived resolver.
- Explicit `anthropic_sdk` and `deepagents` either run the selected model route
  or fail before runner spawn with the required user-facing error.
- `agentEngine` is read-only effective diagnostic output.
- `executionProviderId` is read-only internal diagnostic output.
- Claude OAuth/subscription credentials are accepted only by the Anthropic SDK
  lane.
- Jobs and conversations inherit the bound agent's harness.
- DeepAgents subagents are internal-only execution primitives and do not create a
  dashboard, durable worker roster, or user-managed worker state.
- `AgentDelegation` is the only durable authority path to DeepAgents `task`.
- Denied delegation requests never invoke DeepAgents `task`.
- Raw DeepAgents tool names are not user-facing durable authority.
- Subagent definitions are host-resolved; model output cannot create durable
  subagent identities or widen subagent tools.
- Subagent tool scopes replace parent tool scopes and never merge implicitly.
- DeepAgents file operations use only `FileSearch`, `FileRead`, `FileEdit`, and
  `FileWrite` through Gantry policy.
- Skills project from reviewed skill ids and versions, with explicit subagent
  scopes and no credentials/commands by attachment alone.
- Final responses include the exact evidence receipt format:
  `Completed: <short outcome>`, `Used: <tools/capabilities>`,
  `Changed: <files/accounts/channels or none>`, `Delegated: yes/no`, and
  `Needs attention: <blocker or none>`.

## Test Plan

Focused unit tests:

- settings parse/render/import/export in
  `apps/core/test/unit/config/runtime-settings.test.ts`,
  `apps/core/test/unit/config/settings-import-service.test.ts`,
  `apps/core/test/unit/config/settings-desired-state-service.test.ts`, and
  `apps/core/test/unit/config/desired-settings-writer.test.ts` for
  `defaults.agent_harness` and `agents.<id>.agent_harness`;
- contracts in `packages/contracts/test/unit/index.test.ts` for
  `AgentHarness`, writable `agentHarness`, and read-only `agentEngine` /
  `executionProviderId`;
- Control API agent writes and OpenAPI shape in
  `apps/core/test/unit/control/server-auth.test.ts`,
  `apps/core/test/unit/control/openapi.test.ts`,
  `apps/core/test/unit/control/agent-profile-routes.test.ts`, and
  `apps/core/test/unit/control/model-agent-preview.test.ts`;
- CLI setup/agent/model surfaces in
  `apps/core/test/unit/cli/setup-flow-model-step.test.ts`,
  `apps/core/test/unit/cli/group-engine.test.ts`,
  `apps/core/test/unit/cli/model-preview-format.test.ts`, and
  `apps/core/test/unit/cli/model-command.test.ts`;
- Gantry MCP/admin settings update paths in
  `apps/core/test/unit/jobs/ipc-runtime-admin-handlers.test.ts`,
  `apps/core/test/unit/runner/agent-capabilities.test.ts`, and
  `apps/core/test/unit/runner/mcp/server-registry.test.ts`;
- compatibility resolver coverage for `auto`, forced Anthropic SDK, forced
  DeepAgents, invalid model route, missing credential, unsafe sandbox, and Claude
  OAuth/subscription with DeepAgents;
- read-only behavior for `agentEngine` and `executionProviderId`;
- job/conversation inheritance with no job-level harness write;
- DeepAgents adapter spawn receives only compatible model gateway env;
- raw DeepAgents `task`, `write_todos`, filesystem tools, backends, and raw MCP
  authority stay hidden until Gantry wrappers project them;
- `AgentDelegation` wrapper denies without invoking DeepAgents `task`;
- allowed delegation invokes only host-resolved subagent definitions and records
  audit/runtime evidence;
- subagent tool scopes replace, not merge, with parent tools;
- `FileSearch`/`FileRead`/`FileEdit`/`FileWrite` enforce protected paths,
  symlink canonicalization, sandbox requirements, audit, and receipt evidence;
- skills projection uses reviewed ids/versions and scoped credentials/commands;
- receipt formatter emits exactly `Completed: <short outcome>`,
  `Used: <tools/capabilities>`, `Changed: <files/accounts/channels or none>`,
  `Delegated: yes/no`, and `Needs attention: <blocker or none>`.

Integration tests:

- Anthropic SDK regression for Claude OAuth/subscription lane;
- `auto` harness run for existing Anthropic and OpenAI-compatible model routes;
- explicit DeepAgents run through the Gantry model gateway for a supported
  OpenAI-compatible route;
- explicit DeepAgents rejection for Claude OAuth/subscription credentials;
- scheduled job inherits agent harness, claims run lease before execution, and
  fences terminal/provider writes;
- live turn continuation, stop, close-stdin, pending interaction, and delegation
  resolution stay routed to the durable owner;
- pending interaction row is durable before any DeepAgents-visible approval or
  question rendering;
- production/remote sandbox guard rejects unsafe DeepAgents shell/filesystem
  setup;
- final response receipt and audit/runtime evidence match for delegated/file/tool
  runs.

Cleanup searches before handoff or PR:

```bash
rg -n "agent[_]engine|job\\.harness|executionProviderId.*job|job.*executionProviderId" apps/core/src packages/contracts/src docs
rg -n "LocalShellBackend|BackendProtocol|execute\\b|\\.mcp\\.json|filesystem permissions|interrupt_on" apps/core/src packages/contracts/src docs --glob '!docs/architecture/deepagents-*'
rg -n "ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN" apps/core/src packages/contracts/src docs
rg -n "task.*not policy reviewed|v1-[S]AFEST|no user engine select(or)|S[U]PERSEDED" docs apps/core/src/adapters/llm/deepagents-langchain
```

Final verification commands:

- Run the smallest relevant unit/integration tests after each implementation
  slice.
- For Postgres-backed checks, use a disposable Postgres with required
  extensions per `docs/architecture/current-verification-commands.md`.
- End implementation with `npm run build`, `npm test`,
  `python3 .codex/scripts/verify.py`, and
  `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`.

## Locked Decisions

- Public durable noun: agent harness.
- Public API/SDK field: `agentHarness`.
- Public settings key: `agent_harness`.
- Public values: `auto`, `anthropic_sdk`, `deepagents`.
- UI label: `Execution harness`.
- `auto` preserves current provider-derived behavior.
- `modelAlias` remains the model selector.
- `agentEngine` remains effective read-only diagnostic output.
- `executionProviderId` remains internal/read-only diagnostic output.
- Claude OAuth/subscription remains Anthropic-SDK-only.
- Jobs and conversations inherit the bound agent's harness.
- No job-level, conversation-level, provider-native, or raw backend harness
  authority is introduced.
- DeepAgents subagents are internal execution primitives, not user-managed
  workers.
- No mission-control UI or dashboard is added for DeepAgents subagents in this
  plan.
- `AgentDelegation` is the only durable authority path to DeepAgents `task`.
- Denied subagent requests never invoke DeepAgents `task`.
- Raw DeepAgents tool names are not user-facing authority.
- Host-resolved subagent definitions are authoritative; model output cannot
  persist subagent identities.
- Subagent tool scopes replace parent tools and never merge implicitly.
- DeepAgents filesystem authority goes through Gantry `FileSearch`, `FileRead`,
  `FileEdit`, and `FileWrite` only.
- Skills project from reviewed skill ids and versions, including subagent scopes;
  attachment alone grants no credentials or commands.
- Gantry remains authoritative for memory, jobs, tools, MCP, skills, browser,
  permissions, sandbox, sessions, settings, receipts, runtime events, and audit.
