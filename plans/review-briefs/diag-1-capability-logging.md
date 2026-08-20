# Review brief — DIAG-1: log bounded capability_run args + output

## Goal
Make local-CLI capability executions diagnosable. Today `mcp.tool_activity`
(durable audit + `runtime_events`) records `toolName`, `resultClass`, `latencyMs`,
and a redacted `argumentSummary` — but for `mcp__gantry__capability_run` it drops
the actual `capabilityId`, the args, and the host `stdout`/`stderr`, so after a
scheduled run you cannot see what a capability wrote or what it returned.

## Change
- New `summarizeCapabilityRunAudit` (mcp-tool-audit.ts): only for `gantry`/`capability_run`,
  returns `{capabilityId, args, stdout, stderr}`, each run through `redactMcpAuditText`
  then `truncateAuditText(_, 2000)`; args sliced to the existing `CAPABILITY_RUN_MAX_ARGS`
  (64). Robustly parses the capability result's `JSON.stringify({stdout,stderr})` content shape.
- Threaded into the success path (mcp-tool-proxy.ts at tool completion) and the
  invalid-request path (publishInvalidMcpToolRequestAudit); added `capabilityRun?` to the
  audit payload type (mcp-tool-proxy-audit.ts). Other tools' audit shape is unchanged.

## Args are opt-in (security)
Auto-redacting arbitrary local-CLI argv cannot be made complete (short flags like
`-p`, custom flags, positional secrets), so raw args are **not** logged by default.
- **Default:** `capabilityId` + `argCount` + redacted/bounded `stdout`/`stderr`. No raw argv.
- **Opt-in:** set `GANTRY_AUDIT_CAPABILITY_ARGS=1` to also log the args, best-effort
  redacted (2KB bound; sensitive option flags redact their following value across
  intervening flags). Operators flip this on for a capability whose argv they trust
  (e.g. `gog`, which uses stored OAuth, not argv credentials).

Owner decision: bounded lead PII in the audit log is accepted; credential exposure via
arbitrary argv is avoided by gating args behind the opt-in flag.

## Non-goals
No change to `argumentSummary` or other tools. No full-transcript persistence (that is a
separate follow-up). Capability-only, minimal diff.
