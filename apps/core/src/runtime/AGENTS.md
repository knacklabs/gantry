# Runtime Notes

- Live provider text deltas may contain only whitespace or leading whitespace.
  Runtime streaming must preserve those deltas until the channel stream buffer
  formats the complete visible text.
- MCP caller identity headers are opt-in per approved MCP server version via
  `config.callerIdentity`. Host spawn may inject a signed header only for
  HTTP/SSE MCP servers whose config requires it, using
  `application/mcp/mcp-caller-identity.ts` as the single signer/projection
  owner. Do not add server-name or provider-specific identity branches in
  `agent-spawn`.
- If a Claude provider resume handle returns `No conversation found with
session ID`, expire that provider session and retry the same turn once without
  `resume`. Do not surface the stale provider-handle failure as the user-facing
  answer when a fresh session can handle the turn.
- Pre-agent guardrails run after slash commands and trigger checks but before
  typing, prompt formatting, agent spawn, or tool materialization. Runtime code
  must stay policy-agnostic: route by response kind, pass through policy-owned
  inline system prompt appends, and inject a classifier only for policies that
  still take a classifier path. Keep business-specific copy/rules in
  application guardrail policies.
- The Claude CLI remote-control path was removed. Do not reintroduce direct
  provider-specific remote-control spawning in runtime; any future equivalent
  must be a provider-neutral application capability with explicit permission
  and adapter ownership.
- Prepared execution adapters may pass only narrowly allowlisted runner context
  through `agent-spawn`: provider config/model hints plus host-derived skill
  action metadata. IPC auth tokens, MCP paths, provider credentials, arbitrary
  caller env, and other authority-bearing env must stay host-owned or in the
  model credential runner-input lane.
- Runtime sandbox projection must keep read and write protections separate.
  Generated skill projections and reviewed local CLI credential paths may need
  read access for approved executions, but must remain write-protected.
- Reviewer-authorized memory review runs must bind live continuations to the
  same non-self sender that earned control-approver authority. Do not pipe mixed
  or different-sender channel batches into a run that has memory review decision
  tools available.
- Egress gateway socket resets are tunnel-level failures, not host-runtime
  failures. Every accepted client, direct upstream, and upstream-proxy socket
  must have an error listener before piping so routine `ECONNRESET` events do
  not escape as uncaught exceptions and trigger launchd restarts.
- Thread/topic ids on live permission prompts are routing scope. Persisted
  `Always allow` grants and selected capability runtime projection must use the
  parent conversation identity. Thread/topic ids may choose approval delivery
  and audit metadata, but must not create another permission scope.
- Generated `.llm-runtime` access failures are adapter-state failures. Surface
  actionable `.llm-runtime` guidance instead of returning raw `EACCES` as a
  generic runner-exited error.
- `IDLE_TIMEOUT` controls how long a live runner keeps stdin open for
  in-process continuations after output. A short value such as `2500` is useful
  for broad local regression suites because it frees active-run slots quickly,
  but it is not evidence about realistic warm follow-up retention. Use a bounded
  longer value such as `20000` for warm-retention latency checks, and keep the
  30-minute default in mind when reasoning about production resource tradeoffs.
