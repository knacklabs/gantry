# Plan-contract review brief — AGENTS-WEB-1-2

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task AGENTS-WEB-1-2

### Plan contracts

- **agents-web-browser-pagination**
  - Source: plans/active/AGENTS-WEB-1-build-truthful-agents-management-ui.md#Acceptance Criteria
  - Statement: Agent and custom-role lists support server-owned pagination, search, filters, sorting, and truthful totals.
- **agents-web-browser-security-boundary**
  - Source: plans/active/AGENTS-WEB-1-build-truthful-agents-management-ui.md#Acceptance Criteria
  - Statement: Browser routes enforce session, Administrator, Origin, CSRF, and reauthentication policy without exposing Bearer access or raw records.
- **agents-web-lifecycle-preservation**
  - Source: plans/active/AGENTS-WEB-1-build-truthful-agents-management-ui.md#Acceptance Criteria
  - Statement: Source attachment, capability authority, profile versions, and agent disablement preserve their existing service-owned meanings.

### Reviewer focus

Session versus Bearer separation, sanitised DTOs, server-owned pagination, app isolation, and source visibility remaining distinct from durable capability authority.
