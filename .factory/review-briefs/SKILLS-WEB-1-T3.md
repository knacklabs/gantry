# Plan-contract review brief — SKILLS-WEB-1-T3

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task SKILLS-WEB-1-T3

### Plan contracts

- **SKILLS-WEB-1-T3-AC1**
  - Source: plans/active/SKILLS-WEB-1-skills-inventory-and-agent-attachment-web-ui.md#task-3-administrator-install-and-attachment-workflows
  - Statement: Administrators can choose one ZIP, see the approved same-name update warning, install without automatic attachment, and use success actions to view the skill or attach agents.
- **SKILLS-WEB-1-T3-AC2**
  - Source: plans/active/SKILLS-WEB-1-skills-inventory-and-agent-attachment-web-ui.md#task-3-administrator-install-and-attachment-workflows
  - Statement: Administrators can replace the complete attachment set from a dialog that preserves state on failure and announces success with next-run wording.
- **SKILLS-WEB-1-T3-AC3**
  - Source: plans/active/SKILLS-WEB-1-skills-inventory-and-agent-attachment-web-ui.md#task-3-administrator-install-and-attachment-workflows
  - Statement: Disabled agents remain selectable and are labeled "Disabled · available when the agent is enabled."
- **SKILLS-WEB-1-T3-AC4**
  - Source: plans/active/SKILLS-WEB-1-skills-inventory-and-agent-attachment-web-ui.md#task-3-administrator-install-and-attachment-workflows
  - Statement: Mutation flows invalidate Skills and affected Agent queries without exposing controls to viewer sessions.
- **SKILLS-WEB-1-T3-AC5**
  - Source: plans/active/SKILLS-WEB-1-skills-inventory-and-agent-attachment-web-ui.md#task-3-administrator-install-and-attachment-workflows
  - Statement: Dialog focus, keyboard operation, labels, live status, and narrow-layout behavior follow existing Web UI conventions.

### Reviewer focus

- Load-bearing references: constitution/09-agent-conduct.md, constitution/pnp-coding-standards-modular-monolith.md, docs/architecture/web-ui-foundation.md, docs/architecture/capability-management.md, and docs/decisions/0020-mcp-source-vs-action-capability.md.
- Task-specific seam: use the existing T1 browser endpoints and T2 route state; keep admin dialog orchestration separate from read-only inventory rendering, with no client-side package parser or new dependency.
- Authority boundary: attachment remains selected-skill availability for later agent runs only; declared actions stay read-only metadata and Agent Access remains the only authorization path.
- State correctness: initialize attachments from the lazy server response, preserve confirmed selection on failure, send the complete desired set, and invalidate Skills, navigation summary, and affected Agent queries after success.
- Design attestation: apply emil-design-eng and frontend-design through existing Gantry primitives, native file input, visible focus, live status text, responsive dialog constraints, and no new visual system.

### Accepted verification limitation

- D-0071 defers a component-level DOM test harness: the existing web Vitest runtime is Node-only and this approved task forbids new dependencies. Review the focused facade/unit coverage and the recorded real-browser functional check; do not treat the absent harness as a product defect in this bounded task.
