# {{PROJECT_NAME}} — BRIEF.md

## What

<!-- One paragraph. What are we building and why it matters. Not how. -->

## Who

<!-- 2-4 user types, one line each. Who touches this and what do they care about? -->

- **Role** — what they do with the system

## Flows

<!-- The 3-7 key user journeys in plain English. Each flow is a sentence or two.
     Focus on WHAT happens, not implementation details.
     These become the backbone of the dependency graph. -->

1. **Flow name** — User does X, sees Y, result is Z
2. **Flow name** — ...

## Domain Concepts

<!-- Just the nouns and their relationships. Not schemas, not types, not column names.
     Think whiteboard sketch, not Prisma schema. -->

- **Concept** — one-line description. Related to: [other concepts]

## Constraints

<!-- Things the system can't infer from flows alone.
     Auth, integrations, deployment, business rules, regulatory, performance. -->

- Constraint description

## Out of Scope (v1)

<!-- What we're explicitly NOT building. Prevents scope creep. -->

- Not building X

---

<!-- STOP. That's it. Everything below this line gets DERIVED, not written by you.

What gets derived from this plan:
- Feature nodes (from Flows)
- Requirement nodes (from Features + Constraints)
- Task nodes (from Requirements → implementable files)
- Data models (from Domain Concepts + confirmed Requirements)
- API endpoints (from confirmed Task nodes)
- Frontend pages (from Flows + confirmed Task nodes)
- Build order (topological sort of the task graph)
- Contradiction checks (graph vs conventions)

If you're writing Prisma schemas, API endpoint tables, or page specs in BRIEF.md,
you're doing the graph's job by hand. Stop. Keep this document under 1 page. -->
