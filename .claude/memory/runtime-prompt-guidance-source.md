---
name: runtime-prompt-guidance-source
description: Which code actually feeds the agent system prompt vs. unused/dead guidance renderers
metadata: 
  node_type: memory
  type: reference
  originSessionId: 43aa450f-3e82-4810-baf4-f919f759f5e0
---

The live agent system-prompt guidance is assembled in
`apps/core/src/application/agents/prompt-profile-service.ts`:
`OPERATING_GUIDANCE_BLOCK` (the `# Operating guidance` section), plus
`defaultGroupPromptMarkdown` (→ CLAUDE.md), `defaultSoulPromptMarkdown` (→
SOUL.md), and `capabilityGuidancePrompt()` (the `# Capability guidance`
section). These are what `compileSystemPrompt()` emits.

GOTCHA: `renderDefaultCapabilityRules()` in
`apps/core/src/shared/capability-guidance.ts` is **NOT consumed by any runtime
code** — it has zero importers in src. Only `SOURCE_INVENTORY_AUTHORITY_GUIDANCE`
and `UNREVIEWED_DISCOVERY_GUIDANCE` from that file are actually used (by
runner/mcp/tools service.ts, service-formatters.ts, capabilities.ts). Editing
`renderDefaultCapabilityRules` does NOT change agent behavior. To change prompt
guidance, edit `OPERATING_GUIDANCE_BLOCK` (and wire shared constants into it, as
`PROACTIVE_RECOMMENDATION_GUIDANCE` now is). Related: [[agent-access-simplification]].
