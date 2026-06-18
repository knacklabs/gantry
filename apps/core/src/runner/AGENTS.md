## Runner MCP Capability Notes

- Admin Gantry MCP tools should stay registered in the runner MCP surface and enforce selection at call time. Persistent access approvals (internally still `request_permission` IPC tasks) append live tool rules for the current run, so admin tool handlers must read live rules instead of relying only on startup environment snapshots.
- Keep `request_access` in the baseline Gantry MCP surface. It is the single agent-facing access request/review tool for reviewed semantic capabilities plus exact scoped `RunCommand` fallback requests (target kinds: `capability`, `run_command`), not direct authority; persistent approval stores `capability:<id>` and runtime expands only capabilities with enforceable low-level bindings. Source install/connect and capability review stay outside `request_access`.
- Selected skills may expose trusted action permissions from `gantry.skill.json`. Runner permission suggestions may map a matching Bash/RunCommand leaf to `capability:skill.<skill>.<action>`, but only when the selected skill metadata supplied the semantic definition; never trust free-form agent text for the action display name or durable authority.
- Runner-generated `.llm-runtime/claude/skills/...` paths are temporary
  projections. Permission requests must not persist those paths; map matching
  calls to trusted skill action capabilities or stable `skills/<skill>/...`
  wrappers before presenting durable suggestions.
- Memory IPC auth scope includes reviewer authority. When adding or changing runner boundaries, forward `memoryReviewerIsControlApprover` into the Gantry MCP server environment so memory request signatures match runtime verification.
- SDK model credential env may include only model gateway/auth material. Bash, browser, hooks, and MCP stdio subprocesses may receive no broker proxies or provider tokens; approved tool networking comes from Gantry's provider-neutral `toolNetworkEnv`.
- Keep Claude SDK Bash/RunCommand calls sandboxed with `sandbox.network.allowLocalBinding` so approved CLIs can use the Gantry loopback egress proxy instead of bypassing the sandbox. In `sandbox_runtime`, `toolNetworkEnv` must carry `CLAUDE_CODE_PROXY_RESOLVES_HOSTS=1`, `GODEBUG=netdns=go`, proxy values, and neutral CA aliases, and the runner must prefix approved Bash/RunCommand tool inputs with those sanitized tool-network values. That keeps Go, Python, curl, Node, MCP stdio, and local CLI tools on the same reviewed egress path. On macOS, also enable `sandbox.enableWeakerNetworkIsolation` so Go-based CLIs such as `gh`, `gcloud`, `terraform`, and business CLIs can reach `com.apple.trustd.agent` for TLS certificate verification. These are sandbox transport settings only; they must not grant durable `RunCommand(...)` authority or expose broker proxy/provider credentials to tools.
- Reviewed local CLI credential paths use credential-read semantics: the approved CLI must be able to read them through SDK `additionalDirectories`, while the SDK sandbox must deny writes to those paths. Do not add credential directories to `denyRead`.
- `SandboxNetworkAccess` is a transient SDK callback, not durable capability
  authority. The runner may suppress repeated SDK network prompts only when a
  recent approved tool-use token is still unexpired and the SDK prompt carries
  that exact parent tool-use id, while a short-lived
  eligible-tools/SDK-API-prompt timed grant is active for the same principal and
  conversation, or, for scheduled jobs only, when a parentless SDK network
  prompt arrives immediately after the same principal's approved Bash/RunCommand
  invocation and matches a host hash derived from that latest run-local token.
  Local CLI host hashes may be added to that token only when the approved Bash
  command matches a reviewed local CLI command binding; flat host hints alone
  are not authority.
  Interactive parentless SDK network prompts fail closed, and scheduled
  parentless prompts without a host-bound approved command fail closed. Never log
  raw hostnames or tool inputs for this gate.
- Permission `Allow 5 min` is intentionally a live-interactive-only short-lived
  yolo grant for every eligible SDK tool call and SDK network/API prompt by the
  same principal in the same conversation. Setup, scheduler, admin, and
  capability flows must omit it. Keep protected-path, memory-boundary, and
  fail-closed sandbox hard guards before the timed grant so this option reduces
  live prompts without bypassing safety checks.
- One-shot scheduled jobs must close the SDK prompt stream after the initial prompt is queued. Keeping that async iterable open is live-run behavior for IPC continuations; in scheduled jobs it can leave the SDK waiting for another user turn after tool execution and produce an idle stall instead of a terminal result.
- Claude SDK session persistence is split by run type. Live channel turns may
  use `AgentInput.sessionId` to set `persistSession: true` and `resume`, but
  scheduled/autonomous jobs must keep `isScheduledJob: true`, omit
  `AgentInput.sessionId`, and run the SDK with `persistSession: false` even
  when job metadata has `session_id` or `executionContext.sessionId` for
  app/control correlation.
- Scoped command approval is argv-leaf based. Persist durable `RunCommand(...)`
  rules and project them to the SDK-native Bash tool only inside the selected
  execution harness. Parse `&&`, `||`, `;`, pipes, newlines, and subshell
  leaves; every simple command leaf must match its own durable rule.
  Unsupported shell grammar and destructive redirects fail closed to one-time
  approval, and persistent suggestions must list separate safe leaf rules
  instead of the compound command.
- Native SDK `Agent` and `Task` tool calls are always background work. Force `run_in_background: true` in runner tool input before validation, permission checks, sandbox/network gates, and SDK allow responses; SDK `task_notification` system messages should be emitted as structured runtime events instead of log-only observations.
- Delegation wrappers are authority surfaces. Do not mount `delegate_task`,
  `task_get`, or `task_cancel` until Gantry has a real delegated-task executor
  wired behind them; dormant unavailable handlers and task rows without an
  executor are not a valid delegation implementation.
- Durable file/web authority uses Gantry-owned facade names such as
  `FileSearch`, `FileRead`, `FileEdit`, `FileWrite`, `WebSearch`, and
  `WebRead`. The selected harness maps those names to provider-native tools
  internally. The compact `mcp__gantry__file` tool remains the FileArtifact IPC
  contract and must not expose host filesystem paths.
- `request_skill_install` must forward staged package `files` when available;
  those approvals install and bind the skill. If only `installCommandArgv` is
  supplied, such as an npx catalog installer command, approval runs the exact
  argv in a temporary staging directory, imports the produced `SKILL.md`
  package, and makes the skill available to the agent.
- Bash is acceptable for narrow skill preparation work such as inspecting,
  copying, unzipping, or constructing files. Do not treat those prep permissions
  as durable install authority; the final selected skill still goes through
  `request_skill_install`. `requiredEnvVars` describe runtime skill secrets from
  Gantry Credentials, not generic installer environment.
- Agent-facing capability status blocks are runtime context, not user copy.
  When replying to users, translate them into plain results such as "approval
  requested", "installed", "available now", or "needs setup"; do not echo
  selected-skill lists, internal MCP tool ids, task ids, or raw status blocks
  unless the user asks for technical details.
- Runner-side file IPC response waits should use `waitForIpcResponseFile` so
  response files can wake the runner through `fs.watch` while retaining bounded
  polling as a fallback. Do not add new raw sleep/poll loops for signed
  permission, memory, browser, or task response files.
- Live runner signal drains should use the shared `RuntimeSignalPump` so
  follow-up messages, `_close`, and interaction-boundary files wake the active
  run through `fs.watch`; fallback polling is only missed-event recovery.
