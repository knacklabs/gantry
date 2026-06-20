# Plan Guiding Template

Use this template for meaningful architecture, runtime, prompt, MCP, agent, or
customer-facing behavior plans. The goal is to make plans code-grounded,
modular, reviewable, token-conscious, and hard to confuse with proof.

Do not treat this file as proof. Code and observed runtime behavior are the
source of truth.

## 1. Goal

Define the exact outcome.

- In scope:
- Out of scope:
- Success means:
- Non-goals:

## 2. Current Evidence

Record what is known before proposing changes.

- Code evidence:
- Existing runtime/live evidence:
- Existing payload/log/trace evidence:
- Existing transcript/output evidence:
- Assumptions not yet proven:
- Open questions:

## 3. Source Of Truth

- Code is the source of truth.
- Runtime/live behavior is the acceptance proof for user-facing behavior.
- Docs, MD files, spreadsheets, and prior notes are references, not proof.
- If docs disagree with code or observed behavior, fix the docs after proof.

## 4. Ownership Boundary

Explain where each responsibility belongs.

- Runtime/framework owns:
- Product/domain/agent owns:
- Prompt files own:
- Skill/KB files own:
- MCP/tool contracts own:
- Config owns:
- Docs own:
- Must not be duplicated:

## 5. Surface Impact Matrix

Every meaningful feature or fix plan must classify these surfaces as `Changed`,
`Read-only/observable`, `Unchanged by design`, `Deferred`, or `Not applicable`.
Every `Deferred` or `Unchanged by design` entry must include a reason.

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior |  |  |
| `settings.yaml` |  |  |
| Postgres/runtime projection |  |  |
| Control API |  |  |
| SDK/contracts |  |  |
| CLI |  |  |
| Gantry MCP tools/admin skill |  |  |
| Channel/provider adapters |  |  |
| Docs/prompts |  |  |
| Audit/events |  |  |
| Tests/verification |  |  |

## 6. Phase Plan

Each generated plan should track phase status and update it before moving to the
next phase. Use statuses such as `Not started`, `In progress`, `Blocked`, and
`Done`.

### Phase 0: Baseline

- Status:
- Objective:
- Changes allowed:
- Evidence required:
- Regression risk:
- Reviewer decision:

### Phase 1: Smallest Safe Change

- Status:
- Objective:
- Changes allowed:
- Evidence required:
- Regression risk:
- Reviewer decision:

### Phase 2: Focused Verification

- Status:
- Objective:
- Changes allowed:
- Evidence required:
- Regression risk:
- Reviewer decision:

### Phase 3: Cross-Scenario Regression

- Status:
- Objective:
- Changes allowed:
- Evidence required:
- Regression risk:
- Reviewer decision:

### Phase 4: Final Gate

- Status:
- Objective:
- Changes allowed:
- Evidence required:
- Regression risk:
- Reviewer decision:

## 7. Testing Strategy

Start cheap and deterministic. Only spend live LLM/API/runtime calls when static
evidence shows the change is likely worth testing.

- Static/code checks:
- Unit/integration checks:
- Minimal focused live/runtime tests:
- Cross-scenario regression:
- Payload/log/trace checks:
- Output/reply checks:
- Tool/MCP trace checks:

Before planning or running a full live regression, ask the user:

> Does this plan need full live testing, or only minimal focused live testing?

Default to minimal focused live testing unless the user explicitly approves full
live coverage.

## 8. Live Acceptance Criteria

Use this section only when the change affects live/customer-facing behavior or
external runtime behavior. Live success requires evidence, not confidence.

- Signed webhook/API call passes when applicable.
- Runtime payload/log/trace is inspected.
- User/customer-visible output is inspected.
- Tool/MCP usage is inspected.
- No internal/process leakage.
- No unsupported promises.
- No broad unnecessary MCP/tool fanout.
- Evidence file paths are stored in the plan.

Evidence table:

| Scenario | Runtime evidence | Payload/log evidence | Output evidence | Decision |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 9. Token, Cost, And Rate-Limit Discipline

- Reuse existing evidence before generating new evidence.
- Do not run broad live suites after every small edit.
- Keep prompts, skills, KBs, and docs compact.
- Avoid solving behavior by dumping examples into always-on context.
- Prefer deterministic checks before LLM/API calls.
- Cap parallel live testing to avoid noisy failures and rate-limit collisions.

## 10. Rollback And Cleanup

- Old path removed:
- Duplicate source removed:
- Docs updated:
- Stale references searched:
- Generated artifacts handled:
- No commit/stage unless explicitly requested:

## 11. Self-Review

Before calling the plan ready, answer these honestly.

- Is this the simplest correct architecture?
- Is the ownership boundary clean?
- Is any workaround disguised as long-term design?
- Is there any duplicate source of truth?
- Is context/prompt pollution controlled?
- Is live/runtime proof strong enough for the risk?
- Could this fix one scenario while breaking another?
- Are token, cost, and rate-limit costs justified?
- Is cleanup explicit?

## 12. Final Reviewer Decision

- Approved:
- Approved with changes:
- Blocked:
- Reason:
- Next action:
