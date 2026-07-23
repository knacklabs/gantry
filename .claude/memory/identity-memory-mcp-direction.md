---
name: identity-memory-mcp-direction
description: "Planned - UI + identity layer, personId alias for cross-provider memory consistency, memories exposed as MCP; continuous conversation across surfaces"
metadata: 
  node_type: memory
  type: project
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

User's plan (2026-07-11, ideation stage): build a UI including an identity layer; introduce a canonical **personId with provider-identity aliases** so memories stay consistent for the same human across Slack/Telegram/SDK/UI; **expose memories as an MCP server** so any MCP client can read/write them ("user can be from any direction"); conversation should feel continuous across surfaces.

Recommendations given (agreed direction, not yet locked): link-don't-merge (immutable provider identities + link records with provenance, query-time alias expansion, no historical re-keying — reversible unlink, tractable forget-me); person-scoped auth on the memory MCP (identity token carrying personId enforced at query layer like /v1/usage app scoping — never admin keys); carry the untrusted-memory-never-authority discipline ([[lightweight-agent-modes-pr207]] lesson) into the MCP server docs; continuity = person-keyed memory + canonical session summaries, NOT cross-provider session resume; MCP resources backlog item (P9 in [[dev-experience-gap-analysis]]) is the idiomatic shape. Sequencing: identity/alias first, memory-MCP second, UI last; identity OAuth dovetails with [[connector-strategy-design]]. UI consumers: /v1/usage + lifecycle webhooks from Tiers 1-2. Related: [[prompt-driven-flows-direction]].
