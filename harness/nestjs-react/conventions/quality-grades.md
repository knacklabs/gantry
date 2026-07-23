# Quality Grades

A quality document that grades each product domain and architectural layer, tracking gaps over time. Agents consult this before starting work to know WHERE the codebase is weak.

Reference: [Harness Engineering](https://openai.com/index/harness-engineering/) — "A quality document grades each product domain and architectural layer, tracking gaps over time."

## Grading Scale

| Grade | Meaning | Agent Action |
|-------|---------|--------------|
| **A** | Exemplary — tests, docs, types, error handling all solid | Maintain. Add features freely. |
| **B** | Solid — minor gaps, nothing blocking | Fix gaps opportunistically during related work. |
| **C** | Functional — known debt, missing tests or docs | **Fix existing debt before adding features.** |
| **D** | Needs immediate attention — broken, untested, or unsafe | **Stop. Fix this first. No new features until B or above.** |

Quality can only go up or stay flat. Never ship a PR that lowers a grade without explicit human approval.

## What Gets Graded

### Domains (NestJS Modules)

Each domain module gets a grade: `auth`, `billing`, `users`, `notifications`, `admin`, etc. One row per domain per layer.

### Layers

| Layer | What It Covers | Location |
|-------|---------------|----------|
| Types | Interfaces, DTOs, Zod schemas | `packages/shared/src/` |
| Config | Env vars, constants, validation | `apps/api/src/config/` |
| Repo | Prisma repositories, queries | `apps/api/src/*/repository` |
| Service | Business logic | `apps/api/src/*/service` |
| Runtime | Controllers, guards, filters, middleware | `apps/api/src/*/controller` |
| UI | React components, hooks, pages | `apps/web/src/` |

## Grading Criteria

| Criterion | A | B | C | D |
|-----------|---|---|---|---|
| Test coverage | ≥90% | ≥75% | ≥50% | <50% |
| Linter violations | 0 | 1–3 minor | 4–10 or 1 major | >10 or multiple major |
| Doc completeness | All public APIs documented, JSDoc on exports | Most documented, minor gaps | Partial docs, missing JSDoc | No docs or severely outdated |
| API spec accuracy | Swagger matches implementation exactly | Minor annotation gaps | Missing annotations on some endpoints | Swagger absent or misleading |
| Error handling | All paths covered, typed errors, proper HTTP codes | Most paths covered | Happy path only, some unhandled throws | Raw exceptions leak, no error boundaries |

## The Quality Grades File

Lives at `docs/quality-grades.md` in the generated project. Table format:

```markdown
# Quality Grades

Last full review: YYYY-MM-DD

| Domain | Layer | Grade | Coverage | Violations | Notes | Last Updated |
|--------|-------|-------|----------|------------|-------|--------------|
| auth | Types | A | 95% | 0 | Zod schemas fully typed | 2025-03-10 |
| auth | Config | B | 82% | 1 | Missing env validation for MFA toggle | 2025-03-10 |
| auth | Repo | A | 91% | 0 | — | 2025-03-10 |
| auth | Service | B | 78% | 2 | Token refresh edge case untested | 2025-03-10 |
| auth | Runtime | A | 93% | 0 | Guards well-tested | 2025-03-10 |
| auth | UI | C | 52% | 5 | Login form lacks error states, no a11y tests | 2025-03-08 |
| billing | Types | B | 80% | 1 | Invoice DTO missing optional fields | 2025-03-09 |
| billing | Service | D | 34% | 12 | Stripe webhook handling untested, race conditions | 2025-03-07 |
```

## How Agents Use Quality Grades

### Before Starting Work

1. Open `docs/quality-grades.md`
2. Find the domain + layer you're about to touch
3. If grade is **C or D** → fix existing debt first, then add your feature
4. If grade is **A or B** → proceed with the feature, maintain or improve the grade

### After Completing Work

1. Re-run `check-quality.ts` against the domain you modified
2. Update the row: new grade, coverage %, violation count, notes, date
3. Include the grades update in your PR — it's part of the deliverable

### PR Review Check

Reviewer agents verify:
- Quality grades file was updated if domain code changed
- No grade regressions without human approval comment
- Notes explain any grade that stayed at C or below

## Automation

### `check-quality.ts`

Validates that grades in `docs/quality-grades.md` match actual metrics.

```
npx ts-node scripts/check-quality.ts
```

What it does:
- Reads `docs/quality-grades.md`, parses the table
- Runs `vitest --coverage --json` per domain, compares against stated coverage %
- Runs `eslint --format json` per domain, compares against stated violation count
- Flags **stale grades** — any row with `Last Updated` older than 7 days
- Flags **inflated grades** — stated grade doesn't match actual metrics per the criteria table
- Flags **missing domains** — new modules exist in code but have no grades row

Exit codes:
- `0` — all grades accurate and fresh
- `1` — stale or inflated grades found (prints report)

### CI Integration

Add to `.github/workflows/ci.yml` as a **warn** step (does not block merge):

```yaml
- name: Quality grades check
  run: npx ts-node scripts/check-quality.ts
  continue-on-error: true
```

Why warn-only: grades are a tracking tool, not a gate. Blocking merges on grades creates perverse incentives to game the numbers. The cleanup agent handles remediation.

### Cleanup Agent (Weekly)

Runs every Monday. Responsibilities:
- Re-grade every domain/layer against live metrics
- Update `docs/quality-grades.md` with accurate numbers
- Open a PR titled `chore: weekly quality grades refresh`
- Flag any domains that dropped a grade since last week
- Prioritize D-grade domains for the next sprint's fix queue

## Rules

1. **Every domain module must have grades for all 6 layers.** No gaps.
2. **New modules get graded on their first PR.** Start with actual metrics, not aspirational grades.
3. **Grades are evidence-based.** `check-quality.ts` is the arbiter, not vibes.
4. **Stale grades (>7 days) are treated as C.** If you haven't verified it recently, assume it degraded.
5. **Grade regressions require human approval.** Agent adds a comment: `GRADE_REGRESSION: [domain]/[layer] B→C — [reason]`. Human must reply `approved` before merge.
6. **D-grade domains get priority.** If any domain has a D, agents must fix it before working on B-grade features elsewhere.
