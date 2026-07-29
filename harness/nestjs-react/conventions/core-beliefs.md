# Core Beliefs & Design Principles

> "Technologies often described as 'boring' tend to be easier for agents to model due to
> composability, API stability, and representation in the training set."
> — OpenAI, *Harness Engineering*

This document defines **why** we make the choices we make. Not rules — philosophy.
Every convention, linter rule, and architectural boundary traces back to a belief here.
If a practice can't be grounded in one of these principles, it doesn't belong.

---

## Agent-First Operating Principles

### 1. The repo is the single source of truth

If it's not in the repo, it doesn't exist. No tribal knowledge, no "ask Dave," no
wiki pages that drift from reality. An agent can only reason about what it can read.
Configuration, decisions, context — all checked in, all versioned.

### 2. Map, not manual

`AGENTS.md` is a table of contents — roughly 100 lines, never more. It tells the agent
**where** to look, not **what** to do. The depth lives in `docs/`. The map stays small
enough to fit in any context window. The manuals can be as thorough as needed.

### 3. Progressive disclosure

An agent reads the map first. It digs into specific docs only when the task demands it.
This mirrors how good developers work: scan the index, then drill down. Convention files
are written to support this — clear titles, front-loaded purpose statements, scannable
structure.

### 4. Enforce invariants, not implementations

Define the boundaries: "API responses use this shape," "modules don't import across
domains," "every endpoint has a DTO." Then let the agent decide **how** within those
constraints. Overprescribing implementation details creates brittle conventions that
break the moment a problem doesn't fit the template.

### 5. Boring technology preferred

Stable APIs. Good TypeScript support. Well-represented in training data. NestJS is
"boring." React is "boring." Prisma is "boring." PostgreSQL is "boring." That's the
point. An agent can model boring technology because it's seen thousands of examples.
Novel frameworks with clever abstractions are a tax on every agent interaction.

### 6. Parse at the boundary

Validate data shapes at entry points — API controllers, message consumers, external
service responses. Use Zod schemas, DTOs, and class-validator at the edges. Once data
crosses the boundary and passes validation, trust the types. No defensive checks three
layers deep. The boundary is the firewall; internals are the trusted zone.

### 7. Agent-legible error messages

When a linter fails, the message includes: the exact file, the rule that was broken,
and how to fix it. When CI fails, the log tells the agent what went wrong in plain
language. "Error: `apps/api/src/user/user.service.ts` imports from `order` domain.
Cross-domain imports are not allowed. Use `packages/shared/` for shared types." An
agent that can't parse the error can't fix the problem.

### 8. Plans as artifacts

Complex work is planned in markdown, checked into `plans/`, and updated during
execution. A plan is not a mental model — it's a file. It has a status, a list of
tasks, decisions made along the way, and open questions. When an agent picks up work,
it reads the plan. When it finishes a step, it updates the plan. Plans are the shared
memory between agent sessions.

### 9. Quality ratchet

Quality grades (see `quality-grades.md`) can go up or stay the same. They never go
down without explicit human approval. If a module is graded B, the next change either
keeps it at B or moves it to A. This prevents the slow decay that happens when "just
this once" accumulates. The ratchet only turns one direction.

### 10. Garbage collection over big rewrites

Continuous small cleanup beats quarterly tech debt sprints. Every PR that touches a
file can improve it incrementally — better names, extracted constants, tighter types.
No "Phase 2 rewrite" epics that never ship. The codebase gets cleaner through constant
gentle pressure, not dramatic intervention.

---

## Design Doc Verification

Every document in `docs/` carries a verification badge:

| Badge | Meaning | Action |
|-------|---------|--------|
| ✅ Verified | Matches current code and conventions | None |
| ⚠️ Needs Review | May have drifted from implementation | Human or agent review required |
| ❌ Stale | Known to be outdated | Must be updated or removed |

- `check-docs.ts` validates that every doc has a badge and flags missing ones in CI.
- A doc-gardening agent scans weekly, comparing docs against actual code patterns and
  marking stale entries for review.
- Stale docs are worse than no docs — they teach the agent the wrong thing.

---

## Technology Selection Criteria

Before adding a dependency, answer these:

1. **Is the API stable?** — Breaking changes between minors are disqualifying.
2. **Does it have strong TypeScript support?** — `@types/` bolt-ons are a warning sign.
3. **Can an agent reason about it from in-repo context?** — If understanding the library
   requires reading a 200-page guide that isn't in the repo, reconsider.
4. **Does it hide control flow?** — "Magic" frameworks that use decorators-on-decorators,
   runtime reflection, or implicit registration make agent reasoning fragile. Prefer
   explicit over clever.
5. **Could we reimplement the core need in 50 lines?** — If yes, and the dependency brings
   200KB of transitive packages, write the utility. Own what you can reason about.

Every `package.json` addition is a decision that compounds. Justify it or delete it.

---

## Knowledge Hierarchy

```
AGENTS.md              ← Map (~100 lines). Where to look.
  → docs/              ← Conventions, architecture, patterns. How things work.
    → Code             ← Implementation. Enforced by linters and CI.
      → plans/         ← Active work, decisions, technical debt. Living documents.
        → quality-grades.md  ← Current state. The honest assessment.
```

Each layer is authoritative for its scope. When they conflict:
- **Docs override code** — code is wrong, fix it.
- **Plans override docs** — we're actively changing how things work.
- **AGENTS.md overrides nothing** — it only points. It never prescribes.

---

## The Meta-Belief

This repository is a codebase that happens to be written by agents. The conventions
exist to make agent work reliable, predictable, and continuously improving. But the
underlying principle is simpler than any of the ten beliefs above:

**Make the right thing easy and the wrong thing loud.**

If the right pattern is the path of least resistance, agents will follow it. If the
wrong pattern triggers an immediate, clear, actionable error, agents will learn to
avoid it. Everything else is commentary.
