# Agent Review Loop
> Canon: <!-- canon: constitution/00-agentic-development-workflow.md --> — this file only adds NestJS-React scaffold specifics.

How quality is maintained in a codebase where agents write all code. Humans review only on escalation. Inspired by the [Ralph Wiggum Loop](https://openai.com/index/harness-engineering/) — agents review agents in a loop until all are satisfied.

## The Loop

```
Agent writes code
  │
  ├── 1. Run all checks locally (lint, typecheck, test, check:all)
  ├── 2. Self-review own diff
  ├── 3. Open PR with structured description
  │
  ▼
Request specialized reviewer agents
  │
  ├── Architecture reviewer
  ├── Security reviewer
  ├── Performance reviewer
  │
  ▼
Each reviewer posts comments
  │
  ▼
Original agent responds (fix / explain / escalate)
  │
  ├── All reviewers approve → merge
  └── Unresolved → loop back to reviewer round
```

No human in the critical path. Agents iterate until consensus or escalation.

## Step 1 — Write & Verify

Before touching GitHub, the authoring agent must pass every local check:

```bash
pnpm lint
pnpm typecheck
pnpm test -- --coverage
pnpm check:all        # imports, boundaries, docs, file size
```

All four must pass. No "I'll fix lint later." The PR doesn't exist until checks are green.

## Step 2 — Self-Review

The authoring agent reviews its own diff before opening a PR. This catches the obvious stuff:

- **Logic errors:** Off-by-ones, wrong conditionals, missing null checks
- **Convention violations:** Layer imports going the wrong direction, missing DTOs, raw Prisma in controllers
- **Missing tests:** New code paths without corresponding test cases
- **Missing docs:** New endpoints without Swagger annotations, new modules without AGENTS.md updates
- **File size:** Any file exceeding 200 lines gets split before PR creation
- **Scope creep:** Changes unrelated to the task get reverted or split into separate PRs

Self-review is not optional. It's step 2, not step 0.5.

## Step 3 — Open PR

Every PR uses this description template:

```markdown
## What
One sentence describing the change.

## Why
Context: what triggered this, link to plan/issue.

## How
Key implementation decisions and tradeoffs.

## Testing
What was tested, how, evidence (logs/screenshots if relevant).

## Checklist
- [ ] All checks pass (lint, typecheck, test, check:all)
- [ ] Tests added/updated
- [ ] Docs updated
- [ ] Quality grade reviewed
```

No empty sections. "N/A" is not a valid checklist answer.

## Step 4 — Reviewer Agents

Three specialized reviewers are requested on every PR. Each reviews ONLY their domain.

### Architecture Reviewer
- Layer violations (controller importing repository directly)
- Domain boundary crossings (module A importing from module B's internals)
- Design pattern violations (hand-rolled factories vs shared patterns)
- Missing abstractions or leaking implementation details
- Does NOT comment on CSS, test style, or variable naming

### Security Reviewer
- Auth guard coverage on new endpoints
- Input validation completeness (missing class-validator decorators, unvalidated query params)
- Secrets in code or config (hardcoded keys, leaked env vars)
- Injection risks (raw SQL, unsanitized user input in queries)
- CORS, rate limiting, and header security
- Does NOT comment on architecture or performance

### Performance Reviewer
- N+1 query patterns (loops with DB calls, missing `include`/`join`)
- Missing database indexes for new query patterns
- Unbounded operations (no pagination, no limits on bulk fetches)
- Memory-heavy patterns (loading full tables, large in-memory sorts)
- Missing caching where appropriate
- Does NOT comment on security or code style

### Reviewer Rules

1. **Stay in your lane.** Architecture reviewer doesn't block on missing rate limiting. Security reviewer doesn't refactor module structure.
2. **Be specific.** Reference the file and line. State what's wrong. State what to do instead.
3. **Approve if clean.** If your domain has no issues, approve immediately. Don't block on unrelated concerns.
4. **Ask, don't assume.** If a pattern looks wrong but might be intentional, ask a question instead of requesting changes.
5. **One round max for nitpicks.** If it's not a correctness issue, mention it once and approve anyway.

## Step 5 — Respond & Iterate

The authoring agent processes every reviewer comment:

| Action | When |
|--------|------|
| **Fix** | Reviewer is right. Push a commit addressing the comment. |
| **Explain** | Pattern is intentional. Reply with reasoning and link to relevant convention doc. |
| **Escalate** | Disagreement can't be resolved. Flag for human review. |

The loop continues until all three reviewers approve. Most PRs resolve in 1-2 rounds.

## Self-Review Checklist

Run through before opening any PR:

- [ ] All checks pass locally (`lint`, `typecheck`, `test`, `check:all`)
- [ ] Test coverage didn't drop
- [ ] No source file exceeds 200 lines
- [ ] All new code paths have tests
- [ ] AGENTS.md updated if project structure changed
- [ ] Quality grade updated if module metrics changed
- [ ] Plan file updated if working from one
- [ ] PR diff is under 400 lines (split if larger)

If any box is unchecked, fix it before opening the PR. No exceptions.

## Escalation to Humans

Humans review when agents can't or shouldn't decide alone:

- **Security-critical changes** — auth flows, encryption, secrets management, token handling
- **New domain module creation** — new NestJS module that establishes domain boundaries
- **Quality grade regression** — module grade drops (A→B, B→C)
- **Unresolved disagreements** — authoring agent and reviewer agent can't reach consensus after 2 rounds
- **Architectural decisions** — patterns not covered by existing convention docs

Everything else merges agent-to-agent. Humans review ~10% of PRs, focused on high-impact decisions.

## Cleanup Agent

A recurring cleanup agent runs daily to prevent drift:

- **Pattern scanning:** Detects copy-pasted code, hand-rolled utilities that should use shared packages, inconsistent error handling
- **Grade updates:** Recalculates quality grades from actual metrics (coverage, file sizes, complexity) and updates `quality-grades.md`
- **Targeted refactoring:** Opens small PRs addressing one concern each — rename, extract, consolidate
- **Drift reporting:** Flags modules where actual code diverges from documented conventions

Cleanup PRs follow the same review loop but are typically under 50 lines. Most are auto-mergeable after a single reviewer pass.

Cleanup PR rules: one concern per PR, under 50 lines diff, link to the convention being enforced, auto-merge if all checks pass and single reviewer approves within 1 round.

## What Good Looks Like

- Most PRs merge in under 10 minutes end-to-end
- Reviewer comments are actionable, not philosophical
- Escalations are rare (<10% of PRs)
- Quality grades trend upward over time
- No human is a bottleneck on any PR
