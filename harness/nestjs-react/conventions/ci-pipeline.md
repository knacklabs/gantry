# CI Pipeline

GitHub Actions configuration for NestJS + React monorepos. Every rule here blocks merge or alerts — nothing is advisory-only.

## Pipeline Architecture

```
PR opened/updated
  │
  ├── lint          (30s)   — prettier + eslint on changed files
  ├── typecheck     (45s)   — tsc --noEmit across all packages
  ├── structural    (15s)   — check:all (imports, boundaries, docs, file size)
  ├── unit-tests    (60s)   — vitest run --coverage
  ├── security      (20s)   — npm audit + license check
  │
  └── (all above pass)
        │
        ├── integration-tests  (90s)  — supertest + real Postgres
        ├── build              (60s)  — turbo build (API + web)
        │
        └── (all above pass)
              │
              ├── e2e-tests    (3min) — playwright critical paths
              ├── api-spec     (15s)  — swagger spec diff check
              └── coverage     (10s)  — coverage gate enforcement

Merge to main
  │
  ├── deploy-staging   — auto-deploy, smoke test
  └── (manual gate)
        └── deploy-production
```

---

## Workflows

### 1. PR Checks (`.github/workflows/pr-checks.yml`)

Runs on every PR and push to PR branches. All jobs must pass to merge.

```yaml
name: PR Checks
on:
  pull_request:
    branches: [main]

concurrency:
  group: pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true    # Kill previous runs on new push

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '10'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  structural:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check:all

  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test -- --coverage
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: coverage/ }

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm audit --audit-level=high
      - run: npx license-checker --failOn 'GPL-3.0;AGPL-3.0'

  integration-tests:
    needs: [lint, typecheck, structural, unit-tests, security]
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://test:test@localhost:5432/test
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter api prisma migrate deploy
      - run: pnpm test:integration

  build:
    needs: [lint, typecheck, structural, unit-tests, security]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: actions/upload-artifact@v4
        with: { name: build, path: apps/*/dist/ }

  e2e-tests:
    needs: [integration-tests, build]
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: test, POSTGRES_PASSWORD: test, POSTGRES_DB: test }
        ports: ['5432:5432']
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter api prisma migrate deploy
      - run: npx playwright install --with-deps chromium
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: apps/web/playwright-report/ }

  api-spec:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ env.NODE_VERSION }}', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - name: Generate current spec
        run: pnpm --filter api generate:openapi
      - name: Diff against committed spec
        run: |
          if ! diff -q openapi.json apps/api/openapi.json; then
            echo "::error::OpenAPI spec is out of date. Run 'pnpm --filter api generate:openapi' and commit."
            exit 1
          fi

  coverage-gate:
    needs: [unit-tests]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: coverage }
      - name: Check coverage threshold
        run: |
          COVERAGE=$(jq '.total.lines.pct' coverage/coverage-summary.json)
          echo "Line coverage: ${COVERAGE}%"
          if (( $(echo "$COVERAGE < 100" | bc -l) )); then
            echo "::error::Line coverage ${COVERAGE}% is below 100% threshold"
            exit 1
          fi
```

---

### 2. Deploy (`.github/workflows/deploy.yml`)

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Deploy to staging
        run: pnpm deploy:staging    # CDK deploy or container push
      - name: Smoke test
        run: |
          sleep 10
          curl --fail ${{ vars.STAGING_API_URL }}/health
          curl --fail ${{ vars.STAGING_WEB_URL }}

  deploy-production:
    needs: [deploy-staging]
    runs-on: ubuntu-latest
    environment: production         # Requires manual approval in GitHub
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Deploy to production
        run: pnpm deploy:production
      - name: Smoke test
        run: |
          sleep 10
          curl --fail ${{ vars.PROD_API_URL }}/health
```

---

## What Blocks Merge

Everything. There are no advisory checks.

| Check | Blocks | Why |
|-------|--------|-----|
| Lint (prettier + eslint) | ✅ | Consistent formatting, no lint warnings |
| Typecheck (tsc) | ✅ | No type errors anywhere |
| Structural (check:all) | ✅ | Layer boundaries, file size, import direction |
| Unit tests | ✅ | Business logic correctness |
| Security audit | ✅ | No high/critical vulnerabilities |
| Integration tests | ✅ | HTTP path + database correctness |
| Build | ✅ | Must compile for deployment |
| E2E tests | ✅ | Critical user journeys work |
| API spec diff | ✅ | OpenAPI spec matches code |
| Coverage gate | ✅ | 100% line coverage enforced |

---

## Performance Budget

CI should complete in under 8 minutes total for a PR.

| Job | Target | Hard Max |
|-----|--------|----------|
| lint | 30s | 60s |
| typecheck | 45s | 90s |
| structural | 15s | 30s |
| unit-tests | 60s | 120s |
| security | 20s | 30s |
| integration-tests | 90s | 180s |
| build | 60s | 120s |
| e2e-tests | 3min | 5min |

If any job exceeds hard max, investigate before adding more tests.

### Speed Rules
- `concurrency` with `cancel-in-progress: true` — kill stale runs
- pnpm cache via `actions/setup-node` cache key
- Playwright installs only chromium (not all browsers)
- Integration tests use Alpine Postgres/Redis (smaller images)
- Parallel first-tier jobs (lint, typecheck, structural, unit, security)
- Sequential dependent jobs (integration → e2e)

---

## Branch Protection Rules

Configure in GitHub repo settings:

```
main branch:
  ✅ Require pull request (1 approval)
  ✅ Require status checks:
     - lint
     - typecheck
     - structural
     - unit-tests
     - security
     - integration-tests
     - build
     - e2e-tests
     - api-spec
     - coverage-gate
  ✅ Require branches to be up to date
  ✅ Require linear history (squash merge only)
  ❌ Allow force push (never)
  ❌ Allow deletions (never)
```

---

## Secrets & Environment Variables

```
Repository secrets:
  AWS_ACCESS_KEY_ID          # CDK deploy
  AWS_SECRET_ACCESS_KEY
  OIDC_ISSUER_URL            # E2E test auth / provider discovery
  OIDC_CLIENT_ID
  OIDC_CLIENT_SECRET

Environment secrets (staging/production):
  DATABASE_URL
  REDIS_URL
  JWT_SECRET
```

Rules:
- All secrets in GitHub Settings → Secrets, never in workflow files
- Environment secrets scoped to their environment
- Use `environment:` key for deploy jobs (enables approval gates)
- Rotate secrets quarterly

---

## Anti-Patterns

| Anti-Pattern | Fix |
|-------------|-----|
| Advisory-only checks | Everything blocks merge |
| `continue-on-error: true` | Remove it — failures must fail |
| Skipping tests "to ship faster" | Fix the tests |
| Shared mutable state between jobs | Each job is isolated |
| Hardcoded Node version across files | Use `env.NODE_VERSION` at workflow level |
| Installing all Playwright browsers | `chromium` only (or only what's needed) |
| No concurrency control | Always set `concurrency` + `cancel-in-progress` |
| Manual deploy without approval | Use GitHub environment protection rules |
| Secrets in workflow file | Repository/environment secrets only |
| No smoke test after deploy | Always curl /health after deploy |
