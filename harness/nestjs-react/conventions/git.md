# Git Conventions
> Canon: <!-- canon: constitution/pnp-branch-naming-standards.md --> — this file only adds NestJS-React scaffold specifics.

## Branch Naming

| Prefix      | Purpose                                      |
|-------------|----------------------------------------------|
| `feature/`  | New functionality                            |
| `fix/`      | Bug fixes                                    |
| `chore/`    | Maintenance, dependency updates, CI changes  |
| `refactor/` | Code restructuring without behavior change   |

**Format:** `type/short-description` (kebab-case)
**Agent branches:** `type/issue-NNN-short-description` (linked to Linear/GitHub issue)

### Examples

```
# Good
feature/user-onboarding-flow
fix/billing-invoice-rounding
chore/upgrade-nestjs-11
refactor/extract-auth-middleware
feature/issue-142-add-stripe-webhooks

# Bad
feature/myFeature          # camelCase
fix/stuff                  # vague
john/billing-fix           # named after person
feature/add_new_thing      # underscores
```

## Conventional Commits (Enforced)

**Format:** `type(scope): description`

| Type       | When to use                        |
|------------|------------------------------------|
| `feat`     | New feature                        |
| `fix`      | Bug fix                            |
| `chore`    | Deps, config, maintenance          |
| `refactor` | Restructure without behavior change|
| `test`     | Add or update tests                |
| `docs`     | Documentation only                 |
| `ci`       | CI/CD pipeline changes             |
| `perf`     | Performance improvement            |

**Scope:** Module name — `billing`, `auth`, `web`, `api`, `db`, `shared`
**Breaking changes:** Add `!` after scope — `feat(billing)!: remove v1 endpoint`

### Good Commit Messages

```
feat(auth): add OAuth2 Google provider
fix(billing): handle zero-amount invoices in webhook
chore(deps): bump @nestjs/core to 11.2.0
refactor(api): extract validation pipe to shared module
test(auth): add e2e tests for token refresh flow
ci: add postgres service to GitHub Actions
perf(db): add index on invoices.user_id
feat(web)!: replace legacy dashboard with v2
```

### Bad Commit Messages

```
fix: fixed the thing                # vague, no scope
updated stuff                       # not conventional format
feat(auth): Add OAuth2 Provider     # capitalized description
fix(billing): Fix bug.              # trailing period, vague
wip                                 # not descriptive
feat: add feature                   # redundant, no scope
```

Commitlint + husky enforce this format on every commit. Non-conforming commits are rejected.

## PR Discipline

- **Max 400 lines diff.** Larger changes must be split into stacked PRs.
- **Squash merge only** — keeps `main` history clean and bisectable.
- **PR title** follows conventional commit format: `feat(auth): add OAuth2 Google provider`
- **One approval required**, CI must pass before merge.
- **No force-push** to PRs under review — it destroys review context.

### PR Description Template

```markdown
## What
<!-- One-liner: what this PR does -->

## Why
<!-- Context: why this change is needed -->

## How
<!-- Implementation approach, key decisions -->

## Testing
<!-- How was this tested? Commands to verify -->

## Breaking Changes
<!-- Any breaking changes? Migration steps if yes. Remove section if none -->
```

## Agent-Specific Rules

1. **Commit frequently** — after every passing test cycle, not at the end.
2. **Describe WHAT changed** — `fix(billing): clamp negative totals to zero`, not `fix(billing): fixed the thing`.
3. **Each commit must be independently revertible** — no commit should leave the build broken.
4. **WIP commits get squashed** — clean up before opening a PR. The PR's squash merge title is the final commit message on `main`.
5. **Always link issues** — agent branches use `type/issue-NNN-description` format so traceability is automatic.

## Git Hooks (husky)

| Hook         | Runs                                          |
|--------------|-----------------------------------------------|
| `pre-commit` | `lint-staged` — prettier + eslint on staged files |
| `commit-msg` | `commitlint` — validates conventional commit format |
| `pre-push`   | `tsc --noEmit` + `jest --passWithNoTests`     |

### Setup

Hooks are installed automatically via `prepare` script in `package.json`:

```json
{
  "scripts": {
    "prepare": "husky"
  }
}
```

If hooks aren't running, execute `npx husky` from the repo root.

### lint-staged config (`.lintstagedrc`)

```json
{
  "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml}": ["prettier --write"]
}
```

### commitlint config (`commitlint.config.js`)

```js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', ['auth', 'billing', 'web', 'api', 'db', 'shared', 'deps']],
    'subject-case': [2, 'always', 'lower-case'],
  },
};
```
