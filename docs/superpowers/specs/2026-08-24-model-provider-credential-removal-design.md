# Model provider credential removal

## Goal

Let an administrator permanently remove a stored model-provider credential from
the existing Manage credential dialog, without changing the reversible Disable
provider action.

## Behavior

- The Manage credential dialog shows a separate danger zone only for a stored,
  active credential.
- `Remove credential…` opens a second confirmation dialog. The administrator
  must type the provider label exactly before the destructive action enables.
- Removal deletes the credential row, including its encrypted payload. It does
  not delete the audit event that records removal metadata.
- A disabled credential remains reversible and is not treated as removed.
- The browser endpoint is a new credential-specific DELETE route, so the
  existing DELETE route retains its disable semantics.

## Boundaries

- Change: web dialog, browser credential route, application service, repository
  port and Postgres repository, runtime audit event, focused tests.
- Unchanged: provider registry, settings, CLI and bearer credential API, schema
  shape, SDK, channel adapters, and secret display policy.
- The existing session, origin, CSRF, administrator-scope, and hosted
  reauthentication checks apply unchanged to removal.

## Verification

- Focused service and browser-route tests prove removal deletes the stored row,
  publishes redacted audit metadata, and retains disable behavior.
- Web test proves the danger-zone confirmation is present.
- Run web lint/typecheck, architecture check, deterministic verification, and
  PR checks.
