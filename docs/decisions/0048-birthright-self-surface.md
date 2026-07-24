---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-24
---

# Birthright Self Surface

## Context
Live testing of the shipped PERM-3 build showed the agent being permission-
prompted for its own self-surface — `ask_user_question`, `render_table`, and
read-only introspection — which is UX-hostile and, for `ask_user_question`,
deadlock-prone (the agent must ask permission to ask a question). The PERM-3
benign set covered only `send_message`/`todo_update`/`render_progress` + scheduler
reads, and even those were gated behind the incompleteness/redaction rail. The
agent needs its self-surface freely so it can display, introspect, and
self-debug without asking the human for every internal action.

## Decision
The agent's SELF-SURFACE is birthright (auto-allowed, never prompt), decided by
Ravi 2026-07-24 as classes A+B+C+D: (A) display/interaction (`ask_user_question`,
`render_*`); (B) read-only introspection & self-debug (`task_get/list`,
`scheduler_list_*`/`scheduler_get_job`, `memory_search`, `brain_search/query`,
`continuity_summary`, `mcp_list/search/describe_tool`, `agent_profile_read`);
(C) messaging (`send_message`, `todo_update`); (D) internal state writes
(`memory_save`, `brain_write`, `procedure_save`, `task_cancel`, `task_message`).
Birthright is INPUT-INDEPENDENT — allowed even under redaction/truncation,
checked before the incompleteness rail — because these tools only display to,
read for, or write the agent's own state on behalf of, the trusted user.

## Consequences
- External/side-effecting tools (`mcp_call_tool`, `async_run_command`,
  `async_mcp_call`, `delegate_task`, `RunCommand`, `FileWrite/Edit`, `file`,
  `AgentDelegation`) and requests/consents (`request_*`, `*_consent`,
  `pattern_candidate_decision`) STAY on the ladder — unchanged.
- The birthright set supersedes `BENIGN_GANTRY_MCP_TOOLS` (a subset); the
  redaction-gated benign shortcut is removed.
- Memory/brain content-safety stays in the existing memory-review, NOT the
  permission gate (no double-gate) — see [[semantic-capabilities-are-the-feature]].
- Hard-floors (destructive/privileged/secret/network) are unaffected and remain
  the security control — see [[permission-holistic-redesign]].
