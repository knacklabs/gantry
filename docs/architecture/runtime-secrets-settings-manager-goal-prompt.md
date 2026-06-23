# Runtime Secrets and Settings Manager Goal Prompt

## Goal

Implement a single, clean runtime configuration model for Gantry provider setup,
workspace setup, and fleet redeploy safety.

The product model is:

- Non-secret desired state is centrally managed and versioned.
- Runtime secret values resolve through `RuntimeSecretProvider`.
- Runtime secret values may live in Gantry encrypted DB storage, AWS Secrets
  Manager, runtime environment, or local development storage.
- Desired state stores secret references, never secret values.
- `settings.yaml` remains useful for unmanaged local bootstrap, import, and
  export, but it is not the managed workspace or fleet authority.

This must be a single cut. Do not add compatibility shims, legacy aliases, or a
second settings authority.

## Problem

Provider setup currently mixes three concerns:

- Secret delivery, such as Slack bot/app tokens.
- Non-secret desired state, such as provider connections, Conversations,
  approvers, agent bindings, and triggers.
- Runtime projection rows used by the live process.

That creates bad UX in ECS and future workspace UI/API flows:

- Some setup paths can succeed by writing task-local `.env` or `settings.yaml`.
- Fleet redeploy can start from an empty filesystem and lose local-only setup.
- Users are forced to think about environment variables instead of provider
  connections and secret storage.
- AWS Secrets Manager feels mandatory even though Gantry should also support a
  basic encrypted DB secret store.

## Strong Product Decision

Default basic/workspace UX is `Store in Gantry`.

AWS Secrets Manager and environment variables are external secret sources, not
the default product model. The runtime should not care where a value resolves
from; it should resolve a secret reference through one runtime secret boundary.

Bootstrap secrets still stay outside Gantry DB:

- `GANTRY_DATABASE_URL`
- `SECRET_ENCRYPTION_KEY` or `SECRET_ENCRYPTION_KEYRING_JSON`
- control API bootstrap auth

Everything after bootstrap, including Slack tokens, may be Gantry-managed
encrypted DB secrets.

## Exact UX Contract

Provider setup asks:

```text
Where should Gantry store or read this secret?
```

Choices:

- `Store in Gantry`
- `Use AWS Secrets Manager`
- `Use environment variable`

Default:

- `Store in Gantry`

Success copy:

- Gantry DB: `Slack connected. Secret stored encrypted in Gantry.`
- AWS Secrets Manager: `Slack connected. Gantry saved the AWS secret reference.`
- Environment variable: `Slack connected. Gantry saved the environment variable reference.`

Status labels:

- `Connected`
- `Missing secret`
- `Access denied`
- `Secret ref configured`
- `Rotation needed`
- `Needs redeploy`

Use `Needs redeploy` only for env/ECS-injected secrets where the running process
cannot observe a changed value until restart or task rollout.

Never display a raw secret after save.

## Runtime Secret References

Use one normalized reference shape in desired state:

- `gantry-secret:<id>`
- `aws-sm:<name-or-arn>`
- `env:<VAR_NAME>`

Provider code and channel adapters must not branch on storage location. They
receive the resolved value from `RuntimeSecretProvider`.

## Required Implementation Shape

### Secret storage

Add or reuse encrypted DB-backed runtime secret storage for
`gantry-secret:<id>`.

Reuse existing credential encryption primitives when possible. Do not invent a
second encryption system if the current model/capability credential storage
already provides the needed keyring behavior.

Persist metadata that is safe to show:

- id
- app id
- label
- provider or purpose
- status
- created/updated timestamps
- last rotation metadata if available

Persist encrypted secret value separately from desired state.

Never persist raw secret values in:

- `settings.yaml`
- `settings_revisions`
- provider connection `config_json`
- logs
- audit payloads
- normal API responses

### Desired state

Provider setup writes non-secret setup state to the central desired-state path:

- provider enabled state
- provider connection metadata
- runtime secret refs
- Conversations
- control approvers
- sender policy
- triggers
- agent bindings

Fleet desired state must append a `settings_revisions` row. A fleet mutation that
cannot append a durable revision must fail closed.

Workstation may keep unmanaged `settings.yaml` behavior, but managed UI/API
flows should use the same desired-state service as fleet.

### Setup paths

Remove or guard setup paths that report success after writing only task-local
`.env` or task-local `settings.yaml` in fleet/managed mode.

Provider setup must do both:

- store or validate the selected secret reference
- persist non-secret desired state through the central writer

If either step fails, setup fails with a clear recovery action.

## Acceptance Criteria

- Slack setup survives ECS redeploy from an empty runtime home.
- Slack can be connected with Gantry encrypted DB secrets without AWS Secrets
  Manager.
- Slack can alternatively use AWS Secrets Manager or env refs.
- Workstation and fleet use the same runtime secret reference model.
- Runtime/provider code resolves secrets through `RuntimeSecretProvider`.
- Raw provider secrets never appear in settings documents, revisions, logs,
  provider config JSON, audit payloads, or normal API responses.
- UI/API can manage provider setup later without editing YAML or env files.
- No legacy setup success path remains that only writes ephemeral local files in
  managed or fleet mode.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Runtime secrets resolve through a unified reference boundary. |
| `settings.yaml` | Changed | It stores refs only and is not fleet/workspace authority. |
| Postgres/runtime projection | Changed | Add encrypted runtime secret storage and keep desired state versioned. |
| Control API | Changed | Provider setup/status must manage secret refs and desired state. |
| SDK/contracts | Changed | Expose provider setup/status fields only if needed for UI/API. |
| CLI | Changed | Setup chooses a secret source and writes through the central manager. |
| Gantry MCP tools/admin skill | Changed | Admin tools must use the same desired-state and secret-ref paths. |
| Channel/provider adapters | Unchanged by design | Adapters consume resolved secret values, not storage details. |
| Docs/prompts | Changed | Replace env-first setup guidance with secret-provider guidance. |
| Audit/events | Changed | Audit metadata changes only, never secret values. |
| Tests/verification | Changed | Add persistence, no-leak, and restart/redeploy coverage. |

## Task Decomposition

### 1. Runtime secret reference model

Write scope:

- domain/runtime secret reference parser
- focused unit tests

Acceptance:

- accepts `gantry-secret:`, `aws-sm:`, and `env:` refs
- rejects malformed refs
- never accepts raw token-like values as refs

### 2. Gantry-managed runtime secret store

Write scope:

- encrypted DB repository/service
- schema/migration if existing credential tables cannot be reused cleanly
- tests for encryption and metadata-only listing

Acceptance:

- creates, resolves, rotates, and deletes runtime secrets
- list/status APIs never return plaintext
- missing encryption key fails closed

### 3. RuntimeSecretProvider chain

Write scope:

- runtime secret provider composition
- env resolver
- Gantry DB resolver
- AWS resolver only if the SDK/dependency already exists or the PR explicitly
  accepts adding it

Acceptance:

- provider/channel code resolves by ref
- source-specific errors map to `Missing secret` or `Access denied`
- no adapter imports AWS, Postgres, or env-specific code directly

### 4. Central desired-state persistence

Write scope:

- shared settings writer/sync helpers
- control API composition
- CLI composition

Acceptance:

- workstation unmanaged path still writes `settings.yaml`
- fleet path appends `settings_revisions`
- fleet path cannot fall back to YAML-only persistence
- provider/agent/conversation mutations use this path

### 5. Provider setup cleanup

Write scope:

- Slack first, then shared provider setup helpers
- setup/onboarding paths that currently write `.env` or local YAML directly

Acceptance:

- setup stores or validates secret refs before writing desired state
- setup fails if desired state cannot be durably persisted
- old ephemeral-success path is removed or explicitly workstation-unmanaged only

### 6. Docs and operator guidance

Write scope:

- README setup section
- AWS/ECS deployment docs
- credential-management architecture doc
- relevant decision record

Acceptance:

- docs say AWS Secrets Manager is optional
- docs say Gantry DB secrets are default for basic/workspace
- docs identify bootstrap secrets that cannot live in Gantry DB

## Verification Plan

Run focused checks first:

```bash
npm run test:unit -- apps/core/test/unit/core/model-credential-service.test.ts
npm run test:unit -- apps/core/test/unit/config/desired-settings-writer.test.ts
npm run test:unit -- apps/core/test/unit/config/settings-import-service.test.ts
```

Add and run new focused tests for:

- runtime secret ref parsing
- Gantry encrypted runtime secret storage
- provider setup no-leak behavior
- fleet settings revision persistence

For DB-backed changes, use disposable Postgres with `vector` and `pg_trgm`
enabled, then run only the relevant Postgres integration suites.

Closeout:

```bash
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
.agents/skills/autoreview/scripts/autoreview --mode local
```

If autoreview finds an accepted issue, fix it, rerun focused tests, then rerun
autoreview until clean.

## No-Legacy Cleanup Rules

- Do not leave a fleet path that writes local YAML as authority.
- Do not leave provider setup paths that write raw channel tokens to `.env` in
  managed or fleet mode.
- Do not duplicate credential encryption code.
- Do not add feature flags for old secret behavior.
- Do not add compatibility aliases for old secret ref formats.
- Search for old direct writes before closeout:

```bash
rg -n "saveRuntimeSettings|writeEnvFile|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN" apps/core/src/cli apps/core/src/control apps/core/src/config
```

Every remaining match must be either unmanaged-local only or a read/validation
path, not a managed/fleet authority write.
