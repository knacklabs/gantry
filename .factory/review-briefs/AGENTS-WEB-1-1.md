# Plan-contract review brief — AGENTS-WEB-1-1

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task AGENTS-WEB-1-1

### Plan contracts

- **agents-web-roles-app-scoped**
  - Source: plans/active/AGENTS-WEB-1-build-truthful-agents-management-ui.md#Acceptance Criteria
  - Statement: Custom role templates are app-scoped, validated, and auditable.
- **agents-web-role-snapshot-immutable**
  - Source: plans/active/AGENTS-WEB-1-build-truthful-agents-management-ui.md#Acceptance Criteria
  - Statement: An agent stores an immutable selected role snapshot that survives later role edit or deletion.
- **agents-web-protected-guidance**
  - Source: plans/active/AGENTS-WEB-1-build-truthful-agents-management-ui.md#Acceptance Criteria
  - Statement: Protected Gantry runtime and safety prompt layers remain outside editable role content.

### Reviewer focus

App scoping, unique role names, immutable copied snapshots, migration completeness, and no source-to-authority collapse.
