# Local Agent E2E Test Run — 2026-08-17

## Summary

This report records the local execution of the user-facing agent E2E suite on
branch `codex/e2e-2-user-facing-api-tests` at commit `77b33e225`.

| Result     | Count |
| ---------- | ----: |
| Test files |     7 |
| Test cases |    10 |
| Passed     |     6 |
| Failed     |     1 |
| Skipped    |     3 |

The packaged runtime build passed. The suite ran against PostgreSQL 18 using a
unique database and temporary `GANTRY_HOME` per scenario. Docker was not used
because its daemon was unavailable and the local Postgres server provided the
required `vector` and `pg_trgm` extensions.

## Environment

- Gantry checkout: `/Users/caw-dev/Dev/Agent.Gantry-e2e-2`
- Node: `v24.19.0` (the repository-pinned major version)
- PostgreSQL: `18.4` on `127.0.0.1:5432`
- Runtime target: the packaged `dist/` build from this checkout
- Database policy: the existing `postgres` database was used only as the admin
  endpoint; the harness created and dropped `gantry_e2e_*` databases
- Gantry home policy: fresh temporary home per scenario
- Real model credential: `E2E_MODEL_API_KEY` was not configured
- Evidence directory: `/tmp/gantry-agent-e2e-local-20260817`

## Commands

Build:

```bash
npm run build:runtime
```

E2E suite, with credential values omitted:

```bash
GANTRY_TEST_DATABASE_URL='<local disposable Postgres admin URL>' \
AGENT_E2E_RUNTIME_ROOT='/Users/caw-dev/Dev/Agent.Gantry-e2e-2' \
AGENT_E2E_EVIDENCE_DIR='/tmp/gantry-agent-e2e-local-20260817' \
npm run test:e2e:agent:hermetic
```

## Test Cases and Results

### 1. Fresh runtime boot

Source: [`runtime-boot.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/runtime-boot.agent-e2e.test.ts)

Result: **PASS**

Steps:

1. Create a temporary Gantry home and disposable database.
2. Start the packaged Gantry runtime.
3. Call `/healthz` and require HTTP 200.
4. Call `/readyz` and require database and migration checks to pass.
5. Query the scenario database and confirm at least one Drizzle migration was
   applied.
6. Stop the runtime and clean up its isolated resources.

### 2. Boot health, migrations, and authentication

Source: [`boot-restart.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/boot-restart.agent-e2e.test.ts)

Result: **PASS**

Steps:

1. Start isolated packaged Gantry.
2. Verify `/healthz` and `/readyz`.
3. Confirm migrations exist in the scenario database.
4. Call `/v1/agents` with the generated API key and require success.
5. Call `/v1/agents` without authentication and require HTTP 401.

### 3. Desired state survives restart

Source: [`boot-restart.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/boot-restart.agent-e2e.test.ts)

Result: **PASS**

Steps:

1. Create an agent through `POST /v1/agents`.
2. Record the returned agent ID.
3. Restart the packaged Gantry process.
4. List agents through the public API.
5. Confirm the same agent remains present and active.

### 4. E2E resource cleanup

Source: [`boot-restart.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/boot-restart.agent-e2e.test.ts)

Result: **PASS**

Steps:

1. Tear down the runtime harness.
2. Confirm the temporary Gantry home was removed.
3. Query the Postgres admin endpoint.
4. Confirm the scenario database was dropped.

### 5. Onboarding desired-state lifecycle

Source: [`onboarding.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/onboarding.agent-e2e.test.ts)

Result: **PASS**

Steps:

1. Read the current desired-state revision.
2. Read a persistent capability from the capability catalog.
3. Add the App provider, provider account, agent, capability selection,
   conversation, and conversation installation to desired state.
4. Write the new state using revision-aware `PUT /v1/settings/desired-state`.
5. Confirm the revision advances and the agent is projected through the API
   and Postgres.
6. Restart Gantry.
7. Confirm the revision, agent, conversation installation, and capability
   selection are restored.
8. Preview model routing and confirm the agent workspace resolves.

### 6. Identity and personal-memory lifecycle

Source: [`identity-lifecycle.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/identity-lifecycle.agent-e2e.test.ts)

Result: **PASS**

Steps:

1. Start Gantry with an administrative key and a resolve-only key.
2. Resolve two new external identities and confirm they create different
   people.
3. Resolve one identity again and confirm it maps to the same person.
4. Confirm the resolve-only key cannot expose alias detail or create a missing
   identity.
5. Create person-scoped memory for both people through `/v1/memory`.
6. Preview a merge and confirm the returned fingerprint changes no data.
7. Apply the merge and confirm aliases and personal memory move to the target.
8. Resolve the old source alias and confirm it now reaches the target.
9. Unmerge and confirm the source person and its memory are restored.
10. Confirm cross-app person access is denied.
11. Confirm `identity.resolved`, `identity.merged`, and `identity.unmerged`
    events exist in the scenario database.

Evidence: `/tmp/gantry-agent-e2e-local-20260817/identity-lifecycle.evidence.json`

### 7. Job lifecycle

Source: [`job-lifecycle.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/job-lifecycle.agent-e2e.test.ts)

Result: **FAIL**

Steps reached:

1. Start Gantry with the hermetic runner tools.
2. Create an agent, session, and manual job through public APIs.
3. Pause the job and confirm a trigger is rejected.
4. Resume and trigger the job.
5. Wait for terminal job state.

Expected continuation:

1. The job completes.
2. Its result is delivered to the session.
3. Run, lease, trigger, job events, and delivery evidence are persisted.

Observed failure:

```text
Expected trigger status: completed
Received trigger status: failed
Anthropic SDK query completed without messages or results
```

The packaged runtime reached the SDK runner, but the hermetic Claude fixture did
not produce a message or result. This is the remaining failing local E2E case.

### 8. Configure the real Haiku model

Source: [`haiku-turn.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts)

Result: **SKIPPED** — `E2E_MODEL_API_KEY` was not configured.

Intended steps:

1. Start isolated Gantry.
2. Store the protected Anthropic credential through the Control API.
3. Select the `haiku` chat alias.
4. Read model defaults and confirm the effective alias and provider.
5. Keep the credential out of logs and evidence.

### 9. Complete one real Haiku turn

Source: [`haiku-turn.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts)

Result: **SKIPPED** — `E2E_MODEL_API_KEY` was not configured.

Intended steps:

1. Create an agent and session.
2. Send a user message through the public session API.
3. Wait for a durable assistant response without asserting exact wording.
4. Confirm a public run and `run.started` event exist.
5. Confirm model-usage events identify Anthropic and Haiku.
6. Confirm input and output token counts are positive.
7. Query `/v1/usage` and reconcile it with the run's usage events.

### 10. Coordinator permission authority

Source: [`coordinator-authority.agent-e2e.test.ts`](../../apps/core/test/agent-e2e/scenarios/coordinator-authority.agent-e2e.test.ts)

Result: **SKIPPED** — `E2E_MODEL_API_KEY` was not configured.

Intended steps:

1. Start packaged Gantry with a protected model credential.
2. Select Haiku and create an agent.
3. Give the agent one reviewed `RunCommand` rule.
4. Ask the agent to execute the exact command.
5. Confirm the fixed runtime authority denies the tool call.
6. Confirm the sanitized command and denial are stored in the permission
   records.
7. Confirm `permission.requested`, `permission.cancelled`, and
   `permission.final_outcome` events are recorded.

## Cleanup Verification

After the suite:

- no `gantry_e2e_*` databases remained;
- no packaged E2E Gantry processes remained;
- the existing Gantry home and normal application database were not modified;
- the Git working tree was unchanged by test execution.

## Follow-up

1. Repair the hermetic SDK fixture used by the job-lifecycle scenario.
2. Configure a protected `E2E_MODEL_API_KEY` and run the three model-gated test
   cases.
3. Add protected Slack and Telegram actor lanes only after their dedicated test
   accounts, destinations, credentials, and actor transports are approved.
