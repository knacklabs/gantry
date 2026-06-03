# Gantry Agent Instructions

This repository uses `AGENTS.md` as the primary working contract for coding
agents. Read it first, then follow `WORKFLOW.md`, `docs/FACTORY.md`, and
`docs/QUALITY.md` for factory phase execution.

Gantry-owned capability changes must go through reviewed runtime tools rather
than direct local mutation. Agent-facing capability request and interaction
tools are:

- `send_message`
- `ask_user_question`
- `request_skill_install`
- `request_skill_proposal`
- `request_skill_dependency_install`
- `request_mcp_server`
- `request_access`
- `service_restart`
- `register_agent`

Runtime source of truth remains `settings.yaml` plus application services as
described in `AGENTS.md` and `docs/architecture/capability-management.md`.
