# Monorepo Orchestration Conventions
> Canon: <!-- canon: constitution/01-monorepo-standard.md --> — this file only adds NestJS-React scaffold specifics.

> **Note:** The filename is `nx.md` for historical reasons. This project uses **pnpm workspaces + Turborepo** — not Nx. All conventions here apply to that stack.

How the monorepo is structured, built, tested, and deployed. Every agent working in this
codebase must understand the workspace topology and follow Turborepo's dependency graph.
Never fight the tool — let the pipeline do its job.

---

## Monorepo Structure

### Workspace Layout

```
symphony-forge/
├── apps/
│   ├── api/                  # @symphony/api — NestJS 11
│   └── web/                  # @symphony/web — React 19.2 + Vite 8
├── packages/
│   └── shared/               # @symphony/shared — DTOs, types, zod schemas, utils
├── turbo.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── .npmrc
├── package.json              # Root — scripts, devDependencies, catalog
└── tsconfig.base.json        # Shared TS config extended by each package
```

### pnpm-workspace.yaml

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

No globs beyond this. Every workspace member lives in `apps/` or `packages/`. If you need
a new package (e.g., `@symphony/email`), create it under `packages/` and it's automatically
discovered.

### Package Naming

| Package | Name | Location |
|---------|------|----------|
| API | `@symphony/api` | `apps/api` |
| Web | `@symphony/web` | `apps/web` |
| Shared | `@symphony/shared` | `packages/shared` |

All packages use the `@symphony/` scope. No unscoped packages. No exceptions.

---

## Turborepo Configuration

### turbo.json Pipeline

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["tsconfig.base.json"],
  "globalEnv": ["NODE_ENV", "CI"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "env": ["DATABASE_URL", "REDIS_URL", "VITE_API_URL"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"],
      "env": ["DATABASE_URL", "TEST_DATABASE_URL"]
    },
    "lint": {
      "dependsOn": [],
      "outputs": []
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    }
  }
}
```

### Task Dependency Graph

```
@symphony/shared:build
       │
       ├──────────────────┐
       ▼                  ▼
@symphony/api:build   @symphony/web:build
@symphony/api:test    @symphony/web:test
@symphony/api:typecheck @symphony/web:typecheck
```

The `^build` dependency means: "build all my workspace dependencies first." Since both
`api` and `web` depend on `shared`, Turborepo always builds `shared` before either app.

**`lint` has no `dependsOn`** — it runs independently, in parallel with everything else.

### Caching Strategy

| Cache Layer | Where | When |
|-------------|-------|------|
| Local | `.turbo/` (gitignored) | Always — default, zero config |
| Remote | Vercel Remote Cache or self-hosted | CI + optional local (set `TURBO_TOKEN` + `TURBO_TEAM`) |

**What gets cached:** Task outputs defined in `outputs` — `dist/**`, `coverage/**`.

**What invalidates cache:** Any file change in the package, `globalDependencies` changes,
or env variable changes listed in `env` / `globalEnv`.

**Rule:** Never put secrets in `globalEnv`. Use task-level `env` for secrets that affect
build output (like `DATABASE_URL`). Turborepo hashes env values for cache keys — leaking
secrets into cache hashes is a security footgun.

### Environment Variable Passthrough

| Variable | Used By | Declared In |
|----------|---------|-------------|
| `NODE_ENV` | All | `globalEnv` |
| `CI` | All | `globalEnv` |
| `DATABASE_URL` | `api` | `build.env`, `test.env` |
| `REDIS_URL` | `api` | `build.env` |
| `TEST_DATABASE_URL` | `api` | `test.env` |
| `VITE_API_URL` | `web` | `build.env` |

Any env var that affects build output **must** be declared. If you add a new one and don't
list it, Turborepo will serve stale cache — the worst kind of bug.

---

## Shared Package (@symphony/shared)

### What Belongs Here

| Category | Examples |
|----------|----------|
| DTOs | `CreateUserDto`, `UpdateInvoiceDto` |
| Validation schemas | Zod schemas matching DTOs (`createUserSchema`) |
| API types | Request/response interfaces, pagination types |
| Constants | Enum-like objects, status codes, role definitions |
| Utility functions | `formatCurrency()`, `slugify()`, `isExpired()` |
| Error types | `AppError`, domain error codes |

### What Does NOT Belong Here

| Category | Where It Goes Instead |
|----------|----------------------|
| Business logic | `@symphony/api` service layer |
| Database models / Prisma | `@symphony/api` |
| UI components | `@symphony/web` |
| API client / fetch wrappers | `@symphony/web` |
| Environment config | Each app's own config module |

**Litmus test:** If it needs a runtime dependency beyond `zod`, it probably doesn't belong
in shared.

### Barrel Exports

```typescript
// packages/shared/src/index.ts
export * from './dtos';
export * from './schemas';
export * from './types';
export * from './constants';
export * from './utils';
export * from './errors';
```

Every subdirectory has its own `index.ts`. The root barrel re-exports everything.
Consumers import from `@symphony/shared` — never from deep paths:

```typescript
// ✅ Correct
import { CreateUserDto, createUserSchema } from '@symphony/shared';

// ❌ Wrong — breaks if shared restructures internals
import { CreateUserDto } from '@symphony/shared/src/dtos/user';
```

### Build Configuration

Shared builds with **tsup** for dual ESM + CJS output:

```typescript
// packages/shared/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  outDir: 'dist',
});
```

The `package.json` for shared must declare proper exports:

```json
{
  "name": "@symphony/shared",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"]
}
```

---

## Dependency Management

### pnpm Catalog

Pin shared dependency versions in the root `package.json` using pnpm's catalog feature
(`pnpm-workspace.yaml`):

```yaml
packages:
  - "apps/*"
  - "packages/*"

catalog:
  zod: "^3.24"
  typescript: "^5.8"
  vitest: "^3.1"
  tsup: "^8.4"
  eslint: "^9.10"
```

Packages reference catalog versions with `catalog:`:

```json
{
  "dependencies": {
    "zod": "catalog:"
  }
}
```

**One version per dependency across the monorepo.** No version drift between apps.

### Internal Dependencies

```json
// apps/api/package.json
{
  "dependencies": {
    "@symphony/shared": "workspace:*"
  }
}
```

Always `workspace:*` — never a pinned version. pnpm resolves this to the local package
at install time.

### .npmrc

```ini
shamefully-hoist=false
strict-peer-dependencies=true
auto-install-peers=true
```

| Setting | Why |
|---------|-----|
| `shamefully-hoist=false` | Prevents phantom dependencies — if you didn't declare it, you can't import it |
| `strict-peer-dependencies=true` | Catches peer dep mismatches at install, not at runtime |
| `auto-install-peers=true` | Reduces manual peer dep management |

### Dependency Updates

Use **Renovate** (preferred) or Dependabot with these rules:

- Group all `@symphony/*` internal deps (they move together)
- Pin exact versions for runtime deps, use ranges for devDependencies
- Automerge patch updates that pass CI
- Require manual review for major bumps

---

## Task Orchestration Rules

### Always Run From Root

```bash
# ✅ Correct — from monorepo root
pnpm turbo run build
pnpm turbo run test --filter=@symphony/api
pnpm turbo run dev --parallel

# ❌ Wrong — from package subdirectory
cd apps/api && pnpm build    # Breaks dependency graph, skips shared build
```

**Every task goes through Turborepo.** No exceptions. Running from a subdirectory
bypasses the dependency graph, skips shared builds, and produces broken artifacts.

### Common Commands

| Command | What It Does |
|---------|--------------|
| `pnpm turbo run build` | Build all packages respecting dependency graph |
| `pnpm turbo run test` | Run all tests (shared builds first) |
| `pnpm turbo run lint` | Lint all packages in parallel |
| `pnpm turbo run typecheck` | Type-check all packages |
| `pnpm turbo run dev --parallel` | Start all dev servers simultaneously |
| `pnpm turbo run test --filter=@symphony/api` | Test only the API package |
| `pnpm turbo run build --filter=@symphony/web...` | Build web and all its dependencies |
| `pnpm turbo run build --dry` | Show what would run without running it |

### Filter Syntax

| Pattern | Meaning |
|---------|---------|
| `--filter=@symphony/api` | Only this package |
| `--filter=@symphony/api...` | This package + all its dependencies |
| `--filter=...@symphony/api` | This package + all its dependents |
| `--filter=./apps/*` | All packages under apps/ |
| `--filter=[HEAD~1]` | Only packages changed since last commit |

---

## CI Integration

### GitHub Actions Pipeline

```yaml
name: CI
on: [push, pull_request]

env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2  # Needed for turbo change detection

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: "pnpm"

      - run: pnpm install --frozen-lockfile

      - run: pnpm turbo run lint typecheck --parallel
      - run: pnpm turbo run build
      - run: pnpm turbo run test
```

### Key CI Principles

| Principle | Implementation |
|-----------|----------------|
| Remote caching | `TURBO_TOKEN` + `TURBO_TEAM` env vars enable Vercel Remote Cache |
| Affected-only rebuilds | Turborepo's content-hash change detection — only changed packages run |
| `turbo prune` for deploys | `pnpm turbo prune @symphony/api --docker` produces a minimal lockfile |
| Typecheck is separate | Not embedded in `build` — runs as its own turbo task for better caching |
| Frozen lockfile | `--frozen-lockfile` prevents install-time drift in CI |

### Docker Build with turbo prune

```dockerfile
# Stage 1: Prune to only what @symphony/api needs
FROM node:22-slim AS pruner
WORKDIR /app
COPY . .
RUN npx turbo prune @symphony/api --docker

# Stage 2: Install pruned dependencies
FROM node:22-slim AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN corepack enable && pnpm install --frozen-lockfile

# Stage 3: Build
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@symphony/api

# Stage 4: Production
FROM node:22-slim
WORKDIR /app
COPY --from=installer /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist
CMD ["node", "dist/main.js"]
```

---

## Anti-Patterns

| Anti-Pattern | Why It's Wrong | Correct Approach |
|--------------|----------------|------------------|
| `import { User } from '../../apps/api/src/models'` | Breaks package boundaries, creates invisible coupling | Extract to `@symphony/shared` or keep in the owning package |
| Duplicating types in both `api` and `web` | Drift guaranteed — one changes, the other doesn't | Single definition in `@symphony/shared`, both import from there |
| `cd apps/api && pnpm install` | Corrupts lockfile, installs outside workspace context | Always `pnpm install` from monorepo root |
| `cd apps/web && pnpm build` | Skips shared build, may use stale `dist/` | `pnpm turbo run build --filter=@symphony/web...` from root |
| Circular deps: shared → api or api → web | Breaks topological sort, Turborepo can't resolve build order | Dependency arrows point one way: shared ← api, shared ← web |
| Putting `node_modules` in Docker COPY | Bloated images, platform mismatches | Multi-stage build with `turbo prune` |
| Importing `@symphony/shared/src/dtos/user` | Deep imports break when shared restructures | Import from `@symphony/shared` (barrel export) |
| Env vars not declared in turbo.json | Stale cache served when env changes | Add to `env` array in the relevant task |
| Running `npx` for turbo in CI | Version mismatch, not using workspace turbo | Use `pnpm turbo run` — uses the workspace-installed version |

---

## Adding a New Package

When the monorepo needs a new workspace member:

1. **Create the directory** under `packages/` (library) or `apps/` (deployable)
2. **Add `package.json`** with `@symphony/` scoped name
3. **Run `pnpm install`** from root to link it
4. **Add internal dep** in consumers: `"@symphony/new-pkg": "workspace:*"`
5. **Ensure `build` script exists** if other packages depend on it
6. **Verify with** `pnpm turbo run build --dry` — new package should appear in the graph

No changes to `pnpm-workspace.yaml` needed if it's under `apps/` or `packages/`.
