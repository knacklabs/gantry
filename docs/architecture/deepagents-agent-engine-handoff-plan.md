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
- production hardening around the landed Gantry web/file facade wrappers,
  including sandbox readiness evidence, audit receipts, and final changed-file
  evidence;
- skills projected by reviewed ids/versions with scoped subagent tool sets;
- stdio MCP fail-closed behavior, proxy/egress projection, and sandboxed MCP
  adapter execution before DeepAgents-visible MCP tools are enabled;
- host-enforced evidence receipts for final responses instead of relying on
  model-only formatting;
- cleanup searches and full gates proving stale writable `agentEngine`, raw
  provider authority, raw DeepAgents tools, and old selector paths are absent
  from active surfaces.

Related lifecycle note:

Delegation remains an internal execution primitive until Gantry owns durable
lifecycle state, permission/HITL gates, scope isolation, sandbox boundaries,
user-visible receipts, telemetry, and closeout verification. Do not expose raw
DeepAgents task or async-task tools as product-facing authority.

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

| Value           | Label         | Description                                                                                                           |
| --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `auto`          | Auto          | Gantry chooses the safest compatible harness for the selected model.                                                  |
| `anthropic_sdk` | Anthropic SDK | Use the Claude Agent SDK for Claude-native execution.                                                                 |
| `deepagents`    | DeepAgents    | Use DeepAgents for advanced planning, skills, filesystem workflows, and internal delegation under Gantry permissions. |

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
- Mount DeepAgents File facades only when the host projects the enforcing
  sandbox filesystem flag; under `direct`, File facades stay unavailable even for
  runtime approval prompts.
- Audit every file read/write/edit/search decision with the Gantry facade tool
  name, normalized path or artifact id, policy decision, sandbox provider,
  parent run id, and delegated subagent context when present.
- File write/edit tools must produce durable changed-file evidence for the final
  receipt.

Current-state note: DeepAgents now projects Gantry-owned `WebSearch`,
`WebRead`, `FileSearch`, `FileRead`, `FileEdit`, and `FileWrite` wrappers.
Raw DeepAgents filesystem parity is still not a product contract; production
parity requires sandbox readiness evidence, audit receipts, and final
changed-file evidence to remain verified.

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
- No mission-control UI or dashboard is added for DeepAgents subagents.
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
