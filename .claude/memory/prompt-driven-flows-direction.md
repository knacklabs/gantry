---
name: prompt-driven-flows-direction
description: "Future workflow surface = simple prompt-driven flows/connections, explicitly NOT node/edge graph authoring; deferred by user 2026-07-11"
metadata: 
  node_type: memory
  type: project
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

User's stated plan (2026-07-11, deferred with "we will do it later"): Gantry workflows should be **prompt-driven flows and connections** — described in natural language, approachable for non-technical users — explicitly NOT langgraph-style nodes/edges authoring ("difficult for someone to understand non technical"). Ideation only for now; do not start without the user asking.

**How to apply:** when the user returns to workflows, design a prompt-described flow layer that compiles onto the shipped primitives from [[dev-experience-gap-analysis]] Tier 1/2: direct LLM API steps, inline agent turns with response_schema + tool_rules, task-lifecycle fan-out, webhook-driven transitions (run.completed / interaction.pending). Graph authoring stays out of the UX even if a graph exists internally. Original "graphs deferred; no authoring surface" decision is in [[lightweight-agent-modes-pr207]].
