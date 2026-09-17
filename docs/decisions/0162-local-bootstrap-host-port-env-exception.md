---
status: accepted
confirmed_by: "Ashirwad Shetye"
date: 2026-09-17
stories: [LOCAL-DEV-1]
---

# Local bootstrap host/port env exception (0006)

## Context

Decision 0006 puts non-secret configuration in settings revisions, with
`settings.yaml` as the readable import/export copy, and forbids runtime `.env`
from carrying non-secret configuration such as model selection. Source-local
`gantry local start` needs to bind the control server's host and port before
any settings source can be read: settings live in Postgres once a revision
exists, and reading that revision requires the control server (and therefore
its bind host/port) to already exist. There is no existing bind-host/port
exception, so `GANTRY_CONTROL_HOST`/`GANTRY_CONTROL_PORT` have nowhere
0006-compliant to live for this one bootstrap moment.

## Decision

A narrow, named exception to decision 0006: `GANTRY_CONTROL_HOST` and
`GANTRY_CONTROL_PORT` may be read from runtime `.env` (with the local
supervisor writing sane loopback defaults into `.env` on first bootstrap of a
genuinely new runtime home) for the sole purpose of binding the control
server before any settings source is reachable. This exception covers exactly
these two bind-time keys and only the local source-dev bootstrap path; it does
not reopen `.env` to other non-secret configuration, and once a settings
revision exists it remains authoritative for every other configuration value
per decision 0025.

Because these two keys resolve the bind address before any settings source
exists, decision 0006's usual "process env may override runtime `.env` only
for runtime-owned secrets" restriction does not apply to them: process
environment may override the `.env` value for exactly `GANTRY_CONTROL_HOST`
and `GANTRY_CONTROL_PORT`, matching ordinary CLI/env bootstrap ergonomics.
This is still not a precedent for process-env overrides of any other
settings-owned value.

## Consequences

`local.ts` may read/write these two keys in `.env` without tripping the
wrong-lane check; doctor/preflight should still flag any *other* non-secret
key found in `.env` per 0006. If Gantry later restructures bootstrap so the
control server can resolve its bind address before touching `.env` (e.g. a
fixed loopback default with no override), this exception can be narrowed or
retired — it is not a precedent for putting other configuration in `.env`.
