# Docs

## Scope

- `docs/` contains active product, architecture, security, factory, and operations documentation for Gantry.

## Rules

- Keep docs aligned with the current repo layout and runtime behavior.
- Public onboarding docs must be npm-first (`npx gantry`) before repo-contributor paths.
- Do not leave broken links, hardcoded personal filesystem paths, or example file paths that do not exist in this repo.
- Remove template, fork, or upstream framing from active docs unless a historical note is explicitly required.
- Prefer repo-relative paths and current commands such as `apps/core/...`, `packages/agent-runner/...`, and `ops/...` when describing the codebase.
- When docs change operational commands, verify the command still exists in this repo before publishing it.
- Treat `/v1/webhooks` as outbound callback delivery only. Signed inbound sidecar systems use external ingress records under `/v1/ingresses`; do not describe webhooks as ingress authority.
- Job docs must preserve the settings/runtime boundary: job instances, prompts, schedules, leases, runs, and notification targets are Postgres runtime state, while jobs inherit target-agent tools, skills, and MCP servers instead of carrying job-scoped capability authority.
- Capability docs must keep the semantic model primary: users approve reviewed `capability:<id>` records derived from tool, skill, MCP server, adapter, or CLI manifests. Raw request ids, command hashes, scoped `RunCommand(...)` rules, sandbox profiles, executable paths, and provider implementation details stay in Details/audit sections. Do not document source-code hardcoded capability ids as the authority model.
- Local CLI capability docs must state that user-defined `local_cli` capabilities require pinned executable identity, auth preflight, protected paths, denied environment overrides, and reviewed command templates before runtime projects scoped command authority.
- Credential and runner docs must keep the broker-lane boundary explicit: model credentials stay in `modelCredentialEnv`, approved tool networking is projected through `toolNetworkEnv`, and broker proxies/raw provider tokens must never be described as tool subprocess env.
- Permission docs must describe `SandboxNetworkAccess` as SDK-internal transient defense-in-depth, never as a persistent capability or selected agent tool. The durable user action is a semantic capability, canonical `Browser`, exact Gantry file/web facade, exact admin MCP tool, or scoped `RunCommand(...)` rule.
- User-facing runtime examples must be concise and action-first. Keep internal
  ids, tool rules, task ids, queue diagnostics, and raw logs in details/audit
  sections instead of the primary chat or notification text.
- Admin docs must describe conversation-scoped approvers for both direct/private and group/channel conversations; do not imply Slack, Teams, Telegram, Web, or local user ids are interchangeable.
- Memory docs must describe the current first slice truthfully: flattened `memory_items` is canonical, lexical retrieval is always active, hybrid vector retrieval is active only when embeddings are enabled and ready, `memory_subjects` is not current active schema, and Gantry has no `PostCompact`/`compact_summary` prompt-replay behavior.
- Memory and continuity docs must describe digest-first fresh-run context hydration (recent persisted session digests before active durable memory items), dreaming-only automatic durable promotion/update, and embedding writes limited to dreaming promotion/update plus resumable embedding backfill.
- Continuity docs must preserve the clean-cut contract: unsupported old continuity rows fail closed and are not imported, backfilled, or repaired.
- Memory tool docs must keep `memory_save` limited to canonical direct-save kinds (`preference`, `decision`, `fact`, `correction`, `constraint`) and state that common/global writes require approved admin or service authority.
- SDK docs must describe `sessions.sendMessage` as durable acceptance into the runtime event stream. Do not imply `accepted` or `acceptedEventId` means synchronous model completion or provider/channel delivery success.
- Model docs must use alias-first vocabulary and the live public harness
  selector: `modelAlias`, durable `agentHarness` (`auto`, `anthropic_sdk`, or
  `deepagents`), `responseFamily` (`anthropic` or `openai`), diagnostic
  `modelRoute`, read-only `executionProviderId`, `credentialProfileRef`, and
  capabilities. `settings.yaml` uses `agent_harness`. `auto` preserves
  provider-derived behavior (Claude ->
  `anthropic_sdk`; OpenAI/OpenRouter/Bedrock/Vertex/future OpenAI-compatible
  providers -> `deepagents`); explicit `anthropic_sdk` or `deepagents` records
  user intent and must fail before runner spawn when the selected model is
  incompatible. OpenRouter is its own provider on the DeepAgents/OpenAI-compatible
  lane, not route metadata on an Anthropic alias.
- Job model docs must keep harness selection agent-owned. `job.model`, one-time
  job defaults, and recurring job defaults are approved aliases. Jobs inherit
  model aliases and the bound agent's `agentHarness`. Do not document or add
  public `job.harness`, job-level `agentHarness`, job-level `agentEngine`, conversation-level
  `agentHarness`, or job/conversation-level `executionProviderId` selectors.
- DeepAgents or alternate-harness docs must keep provider-native tool names
  adapter-private. Gantry facade/tool names are the product contract, and docs
  should use the current singular `gantry model ...` CLI surface unless the plan
  explicitly introduces and verifies a CLI rename.
- DeepAgents docs must keep subagents internal. Users see approvals, final
  answer, adaptive evidence receipt, audit, and runtime detail; do not introduce
  a user-facing subagent mission-control UI. Pure chat answers do not need a
  receipt, no-impact work may use only `Completed: <short outcome>`, and
  impactful or delegated work must use the full receipt lines: `Completed`,
  `Used`, `Changed`, `Delegated`, and `Needs attention`.
- DeepAgents raw authority remains Gantry-owned and wrapped. Do not document raw
  `execute`, raw local filesystem access, raw `.mcp.json`, or raw provider
  credentials as possible user or agent authority.
- Runtime scaling docs must treat `RunAdmissionQueue` as execution authority for
  `interactive`, `job`, and `delegation` model work. pg-boss is a scheduler
  trigger, `JobRun` is terminal evidence, and provider-native async subagent
  task state is never durable scaling authority.
- Sandbox and scaling docs must distinguish the `direct` runner provider from
  enforcing providers. A model runner is only OS-contained when
  `runtime.sandbox.provider` is an enforcing provider such as
  `sandbox_runtime` and verification proves the host supports it.
- Runtime refactor plans must keep code anchors current with repo-relative paths and verified line ranges; note stale or removed anchors in the plan instead of leaving historical paths as active guidance.
- Runtime refactor budget docs must distinguish LOCAL-35 phase checks from final PR checks: phase checks use the recorded T0 `--baseline-file`, and final/overall deletion targets use an explicit branch `--base-ref`.
