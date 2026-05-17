## Runner MCP Capability Notes

- Admin Gantry MCP tools should stay registered in the runner MCP surface and enforce selection at call time. Persistent `request_permission` approvals append live tool rules for the current run, so `capability_status` and admin tool handlers must read live rules instead of relying only on startup environment snapshots.
- Keep `capability_search`, `request_capability`, `propose_local_cli_capability`, and `manage_capability` in the baseline Gantry MCP surface. They are review/request tools, not direct authority; persistent approval stores `capability:<id>` and runtime expands only capabilities with enforceable low-level bindings. User-defined `local_cli` proposals stay draft-only until a runtime gate verifies executable identity, preflight, protected paths, and denied environment overrides.
- Memory IPC auth scope includes reviewer authority. When adding or changing runner boundaries, forward `memoryReviewerIsControlApprover` into the Gantry MCP server environment so memory request signatures match runtime verification.
- SDK model credential env may include broker proxy values only for the Claude SDK process. Bash, browser, hooks, and MCP stdio subprocesses may receive no broker proxies or provider tokens; when `NODE_EXTRA_CA_CERTS` is present, derive only neutral CA aliases (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT`, `AWS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, and `DENO_CERT`) from that same path.
- Keep Claude SDK Bash commands sandboxed with `sandbox.network.allowLocalBinding` so approved CLIs can use the SDK-managed local network proxy instead of bypassing the sandbox. Prefix approved Bash commands with `GODEBUG=netdns=go` so Go CLIs use Go DNS resolution instead of macOS resolver services blocked by the sandbox. On macOS, also enable `sandbox.enableWeakerNetworkIsolation` so Go-based CLIs such as `gh`, `gcloud`, `terraform`, and business CLIs can reach `com.apple.trustd.agent` for TLS certificate verification. These are sandbox transport settings only; they must not grant durable Bash authority or expose broker proxy/provider credentials to tools.
- `SandboxNetworkAccess` is a transient SDK callback, not durable capability
  authority. The runner may suppress repeated SDK network prompts while either
  a recent approved tool-use token is still unexpired and unambiguous, or a
  short-lived eligible-tools/SDK-API-prompt timed grant is active for the same principal and
  conversation. Never log raw hostnames or tool inputs for this gate.
- Permission `Allow 5 min` is
  intentionally a short-lived yolo grant for every eligible SDK tool call and SDK network/API
  prompt by the same principal in the same conversation. Keep protected-path,
  memory-boundary, and fail-closed sandbox hard guards before the timed grant so
  this option reduces prompts without bypassing safety checks.
- One-shot scheduled jobs must close the SDK prompt stream after the initial prompt is queued. Keeping that async iterable open is live-run behavior for IPC continuations; in scheduled jobs it can leave the SDK waiting for another user turn after tool execution and produce an idle stall instead of a terminal result.
- Claude SDK session persistence is split by run type. Live channel turns may
  use `AgentInput.sessionId` to set `persistSession: true` and `resume`, but
  scheduled/autonomous jobs must keep `isScheduledJob: true`, omit
  `AgentInput.sessionId`, and run the SDK with `persistSession: false` even
  when job metadata has `session_id` or `executionContext.sessionId` for
  app/control correlation.
- Scoped Bash approval is argv-leaf based. Parse `&&`, `||`, `;`, pipes, newlines, and subshell leaves; every simple command leaf must match its own durable `Bash(...)` rule. Unsupported shell grammar and destructive redirects fail closed to one-time approval, and persistent suggestions must list separate safe leaf rules instead of the compound command.
- Native SDK `Agent` and `Task` tool calls are always background work. Force `run_in_background: true` in runner tool input before validation, permission checks, sandbox/network gates, and SDK allow responses; SDK `task_notification` system messages should be emitted as structured runtime events instead of log-only observations.
- The compact `mcp__myclaw__file` tool is the agent-facing durable-file
  contract. It must talk to the host through signed IPC and use FileArtifact
  virtual paths/artifact refs; do not expose host filesystem paths or add
  separate Gantry MCP tools for each file action.
