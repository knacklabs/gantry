# NestJS + React Harness

A production-ready monorepo template for agent-driven development. Designed to support multiple parallel agents, each working in an isolated git worktree with its own database and app ports.

## Stack

| Layer | Technology |
|-------|-----------|
| API Framework | NestJS 10 |
| ORM | Prisma 5 |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Auth | OIDC provider from BRIEF.md + @nestjs/passport JWT |
| Frontend | React 18 + Vite 5 |
| Routing | TanStack Router |
| Data Fetching | TanStack Query |
| State | Zustand |
| UI Components | shadcn/ui + Tailwind CSS |
| API Client | orval (OpenAPI → typed hooks) |
| Monorepo | pnpm workspaces + Turborepo |
| Tests | Vitest + Supertest + Playwright |
| CI | GitHub Actions |

## Prerequisites

- pnpm 9+
- Node 20+
- Docker + Docker Compose v2
- Auth provider credentials for your chosen OIDC provider — or use local mock auth for development

## Quick Start

### First Time Setup

```bash
# Scaffold from template (do this once per project)
./scaffold.sh my-project /path/to/output

# Boot the full stack
cd /path/to/output
./scripts/boot.sh
```

### Agent Worktree Setup

Each agent gets an isolated environment:

```bash
# From the project root
./scripts/setup-worktree.sh feature/my-feature 1
# Creates worktree at ../my-project-worktrees/feature-my-feature
# Assigns ports: DB=5433, API=3001, Web=5174 (base + offset 1)

# Boot that worktree
cd ../my-project-worktrees/feature-my-feature
./scripts/boot.sh
```

## Project Structure

```
.
├── apps/
│   ├── api/          NestJS backend
│   └── web/          React frontend
├── packages/
│   └── shared/       Shared types and validation schemas
├── scripts/          Worktree and boot scripts
├── linters/          Structural integrity checks
├── docs/             Architecture docs, ADRs
├── AGENTS.md         Table of contents for coding agents
└── WORKFLOW.md       Symphony configuration
```

## Structural Linters

Run before committing. These catch architectural violations that TypeScript won't:

```bash
# Check import direction (Types → Config → Repo → Service → Runtime → UI)
npx ts-node linters/check-imports.ts

# Check domain boundaries (no cross-domain imports without shared package)
npx ts-node linters/check-boundaries.ts

# Check doc freshness and cross-link validity
npx ts-node linters/check-docs.ts
```

Errors are formatted as remediation instructions for agents.

## Key Conventions

See `docs/architecture.md` for the full picture. Short version:

- **Layer dependency flows downward.** Types don't import from services. Repos don't call controllers.
- **Domains don't cross-import.** Auth knows nothing about billing. Use the shared package for types that span domains.
- **One migration per PR.** Don't stack schema changes across parallel branches.
- **Env vars, never hardcoded config.** Every value that changes per environment lives in `.env`.

## Scaffolding a New Project

```bash
./scaffold.sh <project-name> <output-dir> [--port-base 3000] [--db-port 5432]
```

Options:
- `--port-base`: API port (web will be +1) — default 3000
- `--db-port`: Postgres port — default 5432
- `--redis-port`: Redis port — default 6379
: Redis port — default 6379
