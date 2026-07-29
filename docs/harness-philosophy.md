# Harness Philosophy

> **Scope note:** this document describes the contract of GENERATED
> application repos — the linters, boot scripts, and checks named here
> (`check-imports.ts`, `boot.sh`, ...) are produced by
> `harness/nestjs-react/SCAFFOLD_PROMPT.md` in each client repo. They do
> not exist in this template repo itself.

> "The codebase is not just for humans anymore. It's the environment your agent lives in."

This document explains why Symphony Forge is built the way it is — and why each design decision matters when coding agents are the primary contributors.

---

## The Problem We're Solving

OpenAI's research on Codex and SWE-bench surfaced a pattern: agents fail not because they can't write code, but because they can't *navigate* codebases. They:

- Don't know where to add new code
- Don't understand which abstractions already exist
- Violate architectural rules silently (the build still passes)
- Write tests that don't cover the right things
- Make changes that break other parts of the system in non-obvious ways

A human developer compensates with context accumulated over weeks. An agent starts fresh every session. The harness is what replaces that accumulated context.

---

## Principle 1: AGENTS.md as the Table of Contents

Every repo must have an `AGENTS.md` that tells an agent:

1. **How to boot the environment** — exact commands, in order, that work
2. **Where everything is** — a map of the directory structure with purpose annotations
3. **The rules** — what's allowed, what's forbidden, and why
4. **Common tasks** — step-by-step recipes for the 5 most frequent operations

Without this, an agent spends its context budget on exploration. With it, the agent can jump straight to implementation.

**AGENTS.md is a contract.** If it references a file that doesn't exist, the agent is misled. The `check-docs.ts` linter enforces this: every file referenced in AGENTS.md must exist.

---

## Principle 2: Structural Linters Over Conventions

Conventions documented in a README are suggestions. An agent — especially one operating under time pressure or token limits — may not read the README, or may read it and forget it by the time it writes the code.

Structural linters turn conventions into enforced rules:

- **`check-imports.ts`:** Makes the layer dependency direction machine-checkable. An agent can't accidentally build a service that imports from a controller — the linter catches it with an error message that explains exactly what to do instead.

- **`check-boundaries.ts`:** Prevents cross-domain coupling. If the `billing` module starts importing from `auth`'s internals, the linter flags it before it reaches CI.

**The error messages are first-class output.** They're written for agents, not just humans. Every violation message includes:
- The exact file
- The exact import
- Which rule was broken
- What to do instead
- A link to the architecture doc

An agent that reads a well-crafted linter error should be able to fix the violation without additional context.

---

## Principle 3: Parse at the Boundary

All external input — HTTP requests, environment variables, database rows — must be validated and parsed at the boundary before it enters the system.

For the API, this means:
- All `@Body()` parameters go through class-validator DTOs
- All `process.env` access goes through `@nestjs/config` with a validation schema
- Prisma models are never passed raw to API responses — they're transformed through DTOs

For the web app, this means:
- API responses are typed (via the generated client)
- Form inputs are validated with Zod before submission

**Why this matters for agents:** Agents often generate code that accesses `req.body.whatever` without validation, or spreads `process.env` inline. The harness makes it structurally hard to do this — the patterns that work are the safe patterns.

---

## Principle 4: Bootable Per Worktree

Every worktree must be independently bootable. An agent working on a feature branch must be able to:

1. Run `./scripts/boot.sh` from the worktree
2. Get a running environment (Postgres, Redis, API, web) on its own set of ports
3. Make changes, run tests, and verify end-to-end — without touching the main branch

This is enforced by the worktree setup system:
- `scripts/setup-worktree.sh` assigns unique ports via a branch name hash
- `.env.worktree` overrides the port defaults
- `docker-compose.worktree.yml` creates isolated containers for the worktree

Without per-worktree isolation, parallel agent work causes port conflicts, database collisions, and flaky tests. With it, 10 agents can work in parallel on 10 branches simultaneously.

---

## Principle 5: Agent-Readable Errors

Every error in the system — linter output, test failures, runtime exceptions — must be actionable by an agent reading it.

**Bad error:** `TypeError: Cannot read property 'id' of undefined`

**Good error:**
```
VIOLATION: apps/api/src/billing/billing.service.ts imports from UI layer
  (apps/api/src/billing/billing.controller.ts).
  Services must not depend on UI.
  Move shared logic to the Service layer or create a shared type in the Types layer.
  See docs/architecture.md#dependency-direction
```

The difference: the good error tells you the file, the violation, and exactly what to do. The bad error requires a human to debug.

This principle applies everywhere:
- Linter errors (see above)
- Test failure messages must name the failing assertion and what was expected
- HTTP error responses follow a consistent schema (`ApiError`) so the frontend knows what to render
- Boot script failures print which step failed and what to check

---

## The Harness Is Itself a Product

Symphony Forge is not a one-time scaffold — it's a living harness that evolves with the projects it powers.

When you find a class of bugs that agents keep introducing:
1. Add a structural linter that catches it
2. Write the error message to explain the fix
3. Add a doc section explaining the principle
4. Update AGENTS.md to reference the new check

Over time, the harness accumulates the institutional knowledge that would otherwise live only in human engineers' heads — and makes it machine-checkable.

This is the difference between a codebase that an agent can *run in* versus one that merely tolerates agents.
