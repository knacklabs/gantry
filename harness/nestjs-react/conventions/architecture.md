# Architecture Conventions
> Canon: <!-- canon: constitution/03-modular-monolith-structure.md --> — this file only adds NestJS-React scaffold specifics.

Reference doc for the scaffold prompt. These conventions must be baked into every generated project.

## Layer Model

```
┌─────────────────────────────────────────┐
│  UI (React, routes, components)         │  apps/web/src/
├─────────────────────────────────────────┤
│  Runtime (controllers, guards, filters) │  apps/api/src/*/controller, guard
├─────────────────────────────────────────┤
│  Service (business logic)               │  apps/api/src/*/service
├─────────────────────────────────────────┤
│  Repository (DB access via Prisma)      │  apps/api/src/*/repository
├─────────────────────────────────────────┤
│  Config (env, constants)                │  apps/api/src/config/
├─────────────────────────────────────────┤
│  Types (interfaces, DTOs, Zod schemas)  │  packages/shared/src/
└─────────────────────────────────────────┘
```

**Dependency direction: downward only.** Enforced by `check-imports.ts`.

## Domain Boundaries

- One NestJS module = one domain
- No cross-domain imports (enforced by `check-boundaries.ts`)
- Shared types go through `packages/shared/`
- `auth` guards are the only cross-domain exception

## Error Handling

All errors follow the standard shape (statusCode, message, errors[], timestamp, path). Use NestJS exceptions, never manual error construction.

## Auth

OIDC-compliant identity provider (e.g. Azure AD, Auth0, Okta — specified per project in BRIEF.md). JWTs validated against JWKS. No custom token issuance. `@CurrentUser()` decorator for handler injection.

The specific provider is a project decision, not a convention. Conventions define the contract:
- Passport strategy wraps provider specifics
- Guards check JWT claims, never provider APIs
- `AuthenticatedUser` type is provider-agnostic (`{ sub, email, name, roles }`)

## API Patterns

- REST, `/api/v1` prefix
- Cursor-based pagination
- class-validator DTOs for all inputs
- Typed DTOs for all outputs (never raw Prisma)
- Swagger annotations on every endpoint

## Worktree Isolation

Each agent gets isolated ports (API, web, DB, Redis) via hash-based assignment. Boot script handles container creation.
