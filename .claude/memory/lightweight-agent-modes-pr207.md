---
name: lightweight-agent-modes-pr207
description: PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

PR #207 (feature/lightweight-agent-modes, 2026-07-10, 21 commits) shipped both lightweight surfaces from `docs/architecture/lightweight-agent-modes-goal-prompt.md`:

- **Direct LLM API**: `/llm/v1/messages` + `/llm/v1/chat/completions` passthrough via Gantry Model Gateway; `llm:invoke` scope; API-key-scoped gateway tokens; client-side surfaces only (server tools/MCP connector/containers → shaped 400 UNSUPPORTED_FIELD via `llm-request-validator.ts`); upstream abort on client disconnect.
- **Inline runtime**: `runtime: worker|inline` per agent; `runInlineAgent()` (spawn-compatible, resolved-runtime-once); engine-keyed lane dispatcher → in-process claude-agent-sdk / createDeepAgent+PostgresSaver; core tools registry (`runtime/core-tools/`) shared IPC+inline; steering WORKS inline (in-memory control port via `RUNNER_CONTROL_PORT` symbol on the run handle); async subagents + jobs supported; event parity snapshot-tested.

**Autoreview loop took 14 rounds / 13 real findings** — the wildcard-MCP-scope pendulum (round 5 over-exposure → round 7 under-exposure → round 11 double-auth) shows scope-enforcement fixes need both-direction tests in one round. Scheduled inline sessions must be ephemeral (no resume/persistSession — worker parity). Settings sync: new agent fields must be added to `desired-state-current-export.ts` (BOTH construction sites) or sync silently drops them.

Phase 2 MERGED as PR #208 (2026-07-11, merge commit 868b4f7ad): all four stages of `docs/architecture/inline-agent-feature-parity-goal-prompt.md`; autoreview clean after 11 rounds / 14 findings. Key lessons: response_schema binding belongs on the persisted message (not queue signals — three rounds of signal-level patches failed); untrusted memory must never get system authority; caller schema name/title must be pinned on BOTH ToolStrategy and ProviderStrategy; deepagents 1.10.2 auto-installs summarization middleware (adding another breaks graph construction); async-completion assertions in the inline integration suite need vi.waitFor polling.

Disposable test PG: container `gantry-smoke-pg` (port 55433, postgres/smoke) + `gantry_stage2d` DB with vector+pg_trgm extensions.
