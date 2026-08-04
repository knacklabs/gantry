# Gantry Manipal Integration Reconciliation Plan

## Objective

Reconcile `manipal-v2` with current `main` on an isolated branch while keeping
current Gantry runtime, security, browser, capability, and job-coordination
behavior authoritative. Restore the app-scoped contracts used by Agent.Tender
for Source Discovery, Deeper Analysis, and website-recipe creation, and release
the additive Node SDK as `0.6.0`.

## Acceptance criteria

- `main` and `manipal-v2` remain unchanged.
- `@gantry/sdk@0.6.0` is an additive superset of the current SDK and the
  Agent.Tender `0.5.1` integration surface.
- App-scoped runtime-event list/stream is durable and cursor-based.
- Jobs accept a strictly validated `agentTask` and persist it without exposing
  arbitrary executable instructions.
- Structured output, execution timeout, model controls, exact required-skill
  pinning, caller-resolved tools, completion gates, and interaction budgets are
  enforced by Gantry-owned runtime paths.
- Agent and capability reconciliation remains app-scoped and uses reviewed
  catalog authority.
- Source Discovery, Deeper Analysis, and recipe-creation contract tests pass.
- Credential-backed canaries run only in local Docker with dedicated
  development credentials.

## Implementation slices

1. Use the current `main` tree as the reconciled runtime baseline while retaining
   both branch parents in the final merge commit.
2. Restore the typed Agent.Tender job contract and persist it in the existing
   canonical job `target_json`; no new database column is required.
3. Restore app runtime-event and caller-resolved interaction control routes.
4. Project the task contract through current job execution, access snapshots,
   sandbox policy, worker runners, and structured-output validation.
5. Add the missing SDK clients and publish the reconciled package as `0.6.0`.
6. Verify focused unit/integration tests, full build, disposable-Postgres tests,
   and local Docker canaries.

## Surface Impact Matrix

| Surface                     | Classification       | Reason                                                                                                                        |
| --------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Jobs project validated task controls into the existing worker/inline runtimes.                                                |
| `settings.yaml`             | Unchanged by design  | Recipe task controls are per-job data; durable capability selections continue through existing desired-state synchronization. |
| Postgres/runtime projection | Changed              | `agentTask` is stored additively inside existing job `target_json`; no compatibility migration is needed.                     |
| Control API                 | Changed              | Adds app runtime-event streaming, reviewed capability registration, and caller interaction settlement compatibility routes.   |
| SDK/contracts               | Changed              | Adds the Agent.Tender integration surface and releases `@gantry/sdk@0.6.0`.                                                   |
| CLI                         | Unchanged by design  | Application automation uses the SDK; no operator CLI command is required.                                                     |
| Gantry MCP/admin skill      | Unchanged by design  | Capability authority remains in the existing reviewed catalog and access-document services.                                   |
| Channel/provider adapters   | Read-only/observable | Providers execute the projected structured task but gain no new authority.                                                    |
| Docs/prompts                | Changed              | Documents the app-scoped task and event boundary.                                                                             |
| Audit/events                | Changed              | Caller tool requests/results and task terminal events remain app/session/job correlated.                                      |
| Tests/verification          | Changed              | Adds compatibility, execution, SDK, and end-to-end contract coverage.                                                         |

## Security invariants

- Web content and model output cannot add tools, credentials, origins, or
  permissions.
- Caller-resolved tool definitions are typed, bounded, session-scoped, and
  settled through idempotent Gantry-owned records/events.
- Required skills are matched by reviewed binding and exact content hash.
- `responseSchema` must compile and must have an object root.
- Timeouts, interaction counts, and per-scope budgets are bounded by contract.
- Capability registration can only materialize reviewed MCP bindings already
  owned by the authenticated application.

## Verification

```text
npm run test:unit
npm run test:integration
npm run test:integration:postgres
npm test
npm run test:e2e
npm run build
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
```

Credential-backed Source Discovery, Deeper Analysis, and recipe-creation
canaries use local Docker and dedicated development model, Browser, and
Firecrawl credentials. Production credentials and production data are out of
scope.
