---
name: permission-safety
description: Use for tools, permissions, risky actions, sandbox, browser, and execution safety changes in Gantry.
---

# Permission Safety

Use this skill when a task changes tool execution, permission decisions, risky action handling, sandbox policy, browser control, IPC permission flows, or approval UX.

## Required Workflow

1. Read `docs/decisions/0001-agent-runtime-platform.md`, `docs/architecture/codebase-refactor-principles.md`, and `docs/architecture/credential-management.md` when credential access is involved.
2. Ensure risky execution goes through deterministic permission evaluation before a runner, provider callback, browser action, or sandbox lease grants access.
3. Keep audit-relevant decisions explicit: request, policy input, decision, reason, and response path should be testable without provider-specific callbacks.
4. Use `capability-lifecycle` when the change affects durable capability selection, visible attached sources, global inventory, Browser grants, local CLI capabilities, or agent-reviewed access changes.
5. Fail closed on missing, malformed, or late permission responses.
6. Add or update permission, sandbox, browser, or IPC tests for changed behavior.
7. Run `python3 scripts/check_architecture.py` before final handoff when possible.

## Evidence To Provide

- Deterministic decision path.
- Failure mode checked.
- Tests proving deny, allow, and malformed/timeout behavior where applicable.
