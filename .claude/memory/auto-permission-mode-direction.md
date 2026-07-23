---
name: auto-permission-mode-direction
description: "SHIPPED direction - auto-permission classifier locked decisions: host-side independent judge (main agent NEVER judges its own permissions), verdict-as-forced-tool-call, attended prompts never see the capability list"
metadata: 
  node_type: memory
  type: project
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

Auto-permission mode is built (feature/auto-permission-mode, Stages A-F + closeout). Locked decisions confirmed by the user — do not re-litigate:

1. **Classifier = policy compiler, not judge of policy.** allow|ask only, NEVER deny (deterministic tiers own deny). Verdict is gate INPUT, never authority.
2. **The main agent never judges its own permissions** (user-confirmed 2026-07-12). The judge is a host-side independent classifier: sees operator-sourced intent from the message store (never agent self-description — that produced a live wrong verdict), redacted input, and cannot be prompt-injected by the agent's context. A "permission tool the agent calls on itself" was considered and rejected.
3. **Verdict is schema-enforced at the API layer**: forced permission_verdict tool call on the Anthropic direct lane; strict json_schema response_format on the OpenAI-compatible lane (classifier singleRequest queries only). Loose parse + Zod stays as safety net.
4. **Attended verdicts never see approvedCapabilityIds** — the concrete list anchors small models into allowlist refusals (live evidence 2026-07-12: haiku refused "list my drive files" citing the list despite attended=true). Attended = operator instruction IS the authorization for read-only in-scope actions. Unattended = strict capability gate, list included.
5. `attended` is security-relevant and must be derived from the run's scheduled state at every consult seam (P1: inline seam hardcoded true).
6. Flywheel: human allows increment counters; hint at 3+; classifier auto-allows emit one-tap durable offers. Model escalation lever = permissions.auto_mode.model (settings, not code).

Closeout contract: docs/architecture/auto-permission-classifier-closeout-goal-prompt.md. Seams: [[proactive-surfacing-v1]], tool_rules.
