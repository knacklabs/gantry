# Worktree Lifecycle

Each agent works in an isolated git worktree with its own database, Redis, ports, and dev servers. Full isolation — no shared state between worktrees.

## Resource Model

| Resource | Per Worktree | Notes |
|----------|-------------|-------|
| Postgres | Dedicated container | ~100MB RAM baseline |
| Redis | Dedicated container | ~30MB RAM baseline |
| Ports | 3 (API, web, DB) | Hash-based, deterministic |
| node_modules | Symlinked via pnpm | Content-addressable store shared |
| Prisma client | Generated per worktree | Tied to its own DB |

## Concurrency Limits

| Machine | Max Concurrent Worktrees |
|---------|------------------------|
| 16GB M1 | 3-4 |
| 32GB | 6-8 |
| 64GB+ / cloud | 10+ |

Configurable via `SYMPHONY_MAX_WORKTREES` env var. Boot script refuses to create a new worktree if limit is reached.

## Port Allocation

Deterministic, hash-based off branch name:

```
BASE_PORT = 3000 + (hash(branch_name) % 1000) * 10
API_PORT  = BASE_PORT + 0    # e.g., 3450
WEB_PORT  = BASE_PORT + 1    # e.g., 3451
DB_PORT   = BASE_PORT + 2    # e.g., 3452
REDIS_PORT = BASE_PORT + 3   # e.g., 3453
```

Why deterministic: teardown can reconstruct ports from branch name alone. No port registry file to corrupt.

## Lifecycle

### Create

```bash
new-feature <branch-name>
```

What happens:
1. Check worktree count against `SYMPHONY_MAX_WORKTREES`
2. Run orphan detection (see below)
3. `git worktree add ../worktrees/<branch-name> -b <branch-name>`
4. Copy `.env.template` → `.env` with hash-based ports
5. `docker compose -f docker-compose.worktree.yml up -d` (Postgres + Redis with allocated ports)
6. `pnpm install` (fast — pnpm store is shared)
7. `pnpm db:migrate`
8. `pnpm db:seed` (lightweight — under 5 seconds)
9. Start dev servers

**SLA: under 60 seconds from command to running dev servers.**

### Operate

Each worktree is fully independent:
- Own `.env` with unique ports
- Own Postgres container with own data
- Own Redis container
- Own Prisma client (generated against its DB)
- Agents can boot, test, and shut down without affecting other worktrees

Tests run against the worktree's own DB:
```bash
cd ../worktrees/<branch-name>
pnpm test          # Unit tests (Vitest)
pnpm test:e2e      # Integration tests against worktree DB
```

### Teardown

Triggered automatically by:
- PR merged
- PR closed
- Manual: `teardown-worktree <branch-name>`

What happens:
1. Stop dev servers
2. `docker compose -f docker-compose.worktree.yml down -v` (removes containers + volumes)
3. `git worktree remove ../worktrees/<branch-name>`
4. Clean up `.env` and generated files

### Orphan Detection

**Runs automatically at every worktree creation.**

Detects:
- Docker containers with worktree labels but no matching git worktree
- Git worktrees with no matching branch (deleted remotely)
- Worktrees with no commits in the last 2 hours and no running agent process

Resolution:
- Orphaned containers → killed and removed
- Orphaned worktrees → logged with warning, auto-cleaned after 4 hours of inactivity
- Port conflicts → blocked port's owner identified and reported

### Crash Recovery

If an agent process crashes mid-work:
1. Worktree remains intact (work is preserved in git)
2. Containers keep running (no auto-kill on agent exit)
3. Next `new-feature` invocation runs orphan detection
4. Stale worktrees can be resumed: `resume-worktree <branch-name>` (restarts dev servers, no re-scaffold)

## Docker Compose (Worktree Overlay)

The `docker-compose.worktree.yml` uses environment variables for isolation:

```yaml
services:
  postgres-${BRANCH_HASH}:
    image: postgres:17
    ports:
      - "${DB_PORT}:5432"
    environment:
      POSTGRES_DB: ${PROJECT_NAME}_${BRANCH_HASH}
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - pgdata_${BRANCH_HASH}:/var/lib/postgresql/data
    labels:
      - "symphony.worktree=${BRANCH_NAME}"

  redis-${BRANCH_HASH}:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT}:6379"
    labels:
      - "symphony.worktree=${BRANCH_NAME}"
```

Labels enable orphan detection — `docker ps --filter label=symphony.worktree` lists all worktree containers.

## Environment File (.env per worktree)

```
DATABASE_URL=postgresql://postgres:postgres@localhost:${DB_PORT}/${PROJECT_NAME}_${BRANCH_HASH}
REDIS_URL=redis://localhost:${REDIS_PORT}
PORT=${API_PORT}
WEB_PORT=${WEB_PORT}
NODE_ENV=development
BRANCH_NAME=${BRANCH_NAME}
```

Generated automatically by `new-feature`. Never edit manually.

## Anti-Patterns

- **DO NOT** share a database between worktrees (migration conflicts, test data pollution)
- **DO NOT** hardcode ports anywhere (use env vars)
- **DO NOT** leave worktrees running after PR merge (resources leak)
- **DO NOT** skip orphan detection (one leaked Postgres = 100MB RAM gone)
- **DO NOT** use `docker compose down` without `-v` (volumes accumulate silently)
