# Runtime Notes

- Live provider text deltas may contain only whitespace or leading whitespace.
  Runtime streaming must preserve those deltas until the channel stream buffer
  formats the complete visible text.
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
- Shared runtime accepts Gantry-owned `toolPolicyRules` and neutral
  `providerSession` output. Provider-native names such as Claude SDK
  `allowedTools` and stale provider-session error strings belong behind the
  execution adapter boundary.
- Runtime queue backlog caps live under `runtime.queue`; a cap of `0` means
  unlimited/current behavior. Keep backlog caps separate from concurrency limits
  and apply them only at new waiting-work admission.
- Message backlog admission must be checked from every path that adds a group
  to `waitingMessageGroups`, including pending messages discovered while a
  task or active run drains. Deferred pending state should stay durable in the
  group until backlog capacity opens.
- `GroupQueue` is process-local live-turn state. Horizontal scheduler workers
  must set `runtime.live_turns.enabled: false`; only the single live-turn host
  may run live message polling or admit live-turn ownership. Channels still
  connect so scheduler outbound delivery can fail closed or send normally
  instead of falsely stamping notification evidence.
- Scheduled question IPC must carry the same run lease identity as scheduled
  permission IPC. Recheck the lease before rendering a question prompt and
  again before writing the answer response.
