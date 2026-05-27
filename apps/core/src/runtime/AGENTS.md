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
  must stay policy-agnostic: inject a classifier and route by response kind;
  keep business-specific copy/rules in application guardrail policies.
