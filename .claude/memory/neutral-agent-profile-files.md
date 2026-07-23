---
name: neutral-agent-profile-files
description: Neutral SOUL.md + AGENTS.md agent profile feature; replaced provider-named CLAUDE.md profile
metadata: 
  node_type: memory
  type: project
  originSessionId: 77da0238-2b4b-41d1-a5d9-6e158411666d
---

Shipped on branch `feat/neutral-agent-profile-files` (off `feat/agent-access-simplification`): replaced the provider-named per-agent `CLAUDE.md` profile FileArtifact with a neutral `AGENTS.md`, added per-agent `relationship_mode` (`personal`|`organization`, default `personal`), exposed profile files as versioned read/write surfaces across Control API / CLI / MCP, and materialized visible disk mirrors.

Non-obvious facts worth keeping:
- Profile prompt FileArtifacts are keyed by `appId='default'` + `agentId='agent:<folder>'` (scope `prompt-profile`). `memoryAgentIdForWorkspaceFolder` and `promptProfileAgentIdForFolder` both yield `agent:<folder>` — must match seeding when reading. Control API resolves folder via `folderForAgentId(agentId)` (strip `agent:`), NOT the agent record's own id.
- Disk mirrors at `~/gantry/agents/<folder>/{SOUL,AGENTS}.md` are safe because the live runner uses `settingSources: ['user']` (runner/query-loop.ts) — the Claude SDK does NOT auto-load AGENTS.md/CLAUDE.md from cwd, so mirrors are inert human views, not a second prompt source. Profile content reaches the model only via the FileArtifact-backed system prompt.
- `SOUL.md`/`AGENTS.md` are hard-blocked in the generic `file` tool (always rejected → directs to `request_agent_profile_update`), via `isProtectedProfileFileArtifactVirtualPath`. Other protected paths (settings.yaml/.mcp.json/SKILL.md) keep the admin+`protected=true` gate.
- New MCP tools `agent_profile_read` + `request_agent_profile_update` are baseline (in `BASELINE_GANTRY_MCP_TOOL_NAMES`). MCP update path lives in jobs/ (runtime layer) so it mirrors with no layer violation; the Control API PUT (adapter layer) needed a registered architecture exception.
- Architecture exceptions added under `canonical-boundary-cleanup-phase` for cli/control adapter -> platform/config imports (mirror). `group.ts` line budget bumped 820->824.
- Optimistic concurrency: `AgentProfileService.writeProfileFile({expectedVersion})` throws `ProfileVersionConflictError` -> Control API 409; MCP returns a plain refresh blocker.

Verify: typecheck + build clean; full unit suite green; architecture check shows only the 2 pre-existing file-size failures (`ipc-admin-handlers.ts`, `agent-spawn.ts` — see [[preexisting-egress-noproxy-test-failure]]). Relates to [[runtime-prompt-guidance-source]], [[permission-folder-key-pairing]], [[agent-access-simplification]].
