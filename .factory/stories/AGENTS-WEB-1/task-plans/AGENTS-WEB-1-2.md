# AGENTS-WEB-1-2: Truthful browser agent projections

## Objective

Provide the session-bound, app-scoped backend projection that the Agents web UI
uses for real lists, details, roles, and lifecycle actions without exposing the
Bearer control API or raw persistence records.

## Exact changes

- Add compact contracts for paginated agent and role directory results plus
  browser-safe agent detail and lifecycle responses.
- Add a dedicated `/ui/api/agents` route family following the existing browser
  auth, role, Origin, CSRF, and hosted reauthentication policy.
- Implement repository/application projections for server-side pagination,
  search, filters, sort, role reads and current configuration information.
- Delegate agent enable/disable and role changes to the existing services;
  do not make source attachment a capability grant or create an alternate
  persistence path.
- Add focused browser route tests for pagination/app isolation and mutation
  auth boundaries.

## Boundaries

- `/v1/*` stays Bearer-only; `/ui/api/*` stays session-only.
- Browser DTOs omit raw settings, credentials, and repository records.
- No web components, wizard implementation, profile-file editing, or new
  source/capability semantics in this backend stage.

## Proof

- Browser facade tests prove server-owned pagination and cross-app rejection.
- Browser facade tests prove Administrator, Origin, CSRF, and hosted
  reauthentication checks on every mutation.
- Contract build and typecheck catch DTO and registration drift.

## Review focus

Review authentication boundaries, DTO sanitisation, pagination correctness,
app isolation, and preservation of existing lifecycle service ownership.
