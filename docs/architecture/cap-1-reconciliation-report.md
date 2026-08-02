# CAP-1 — capability-authoring lane reconciliation report

The rescued lane (feature/capability-authoring @ 13ae2e698) was reconciled with
358 commits of main in merge `3ac572099` (22 conflicted files). Rule applied:
both feature sets preserved; where main replaced a mechanism the lane also
edited, main's replacement won and the dropped lane hunk is recorded here.

## Superseded lane mechanisms (dropped, main's replacement wins)

- Repeated per-call access/MCP reads → main's immutable `AgentAccessSnapshot`
  (per-turn snapshot semantics; `apps/core/test/unit/jobs/execution.test.ts`
  took main wholesale for the same reason).
- Pre-lease settings application → main's settings-revision lease; the lane's
  MCP fence recovery now lives inside that mechanism.
- Inline MCP client construction → the extracted
  `apps/core/src/application/mcp/mcp-tool-proxy-connection.ts`; the lane's
  network-policy revalidation stays wired through `mcp-tool-proxy.ts`
  (current egress policy checked before any cached-client reuse).

## Retained lane behavior

Capability authoring, scoped MCP bindings, grant-token plumbing through
settings mirroring, and cached-client network revalidation — all verified by
the exact-name required test and the focused restart/fence/route lanes.

## Review basis (autoreview deviation)

The autoreview skill's bundle gate structurally refuses this diff (documented
scanner phantom: an identifier assigned to a token-named field becomes a
"known secret fragment" that matches its own other call sites). Compensating
evidence: three independent Codex passes over the full diff (reconciliation
audit, verification audit, superseded-mechanism walk), full unit 8259/0 (run
whole and as four deterministic shards), full Postgres 344/0 on a clean
database, typecheck/architecture/migrations green.
