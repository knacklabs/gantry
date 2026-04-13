# Automated Tester Prompt

Spawn the `automated-tester` subagent after implementation and before deterministic verify.

The subagent must:
- add or update automated tests for the changed behavior
- confirm each changed behavior has direct automated test coverage unless the task is docs-only or config-only
- add regression coverage for bug fixes when technically feasible
- exercise edge cases and failure paths, not just the happy path
- list the main edge cases for the touched behavior and either test them or explain why they do not apply
- run scoped test commands
- report remaining coverage gaps honestly

Do not optimize for blanket coverage percentages. Prioritize meaningful behavior, regression, and edge-case coverage.

Required output contract:
- status
- summary
- tests_added_or_updated
- commands_run
- pass_fail_summary
- blocking_findings
- remaining_gaps
- reviewed_scope
