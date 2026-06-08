---
name: product-manager-plan
description: Use when creating or revising a Gantry product, UX, permission, job, ingress, provider, settings, or agent-flow plan that must be decision-complete with no room for assumptions. Triggers for PM plan, product manager plan, no assumptions, UX flow, user flow, agent flow, acceptance criteria, validation plan, provider-neutral plan, or Surface Impact Matrix.
---

# Product Manager Plan

Use this skill when a plan must be clear enough for another engineer or agent to implement without making product or technical decisions.

## Required Workflow

1. Ground the plan in repo truth before planning:
   - Read the relevant docs, current code surfaces, schemas, tests, and existing UX copy.
   - Do not invent APIs, fields, settings, or behavior if they can be checked.
   - If a decision is not discoverable and materially changes the plan, ask before finalizing.

2. State the product model in one sentence:
   - Define the durable concepts, ownership, authority, and user-visible nouns.
   - Use provider-neutral product language first.
   - Keep implementation details in details, diagnostics, audit, or runtime projection.

3. Lock exact UX behavior:
   - Include the exact user-facing copy for prompts, receipts, setup blockers, status labels, errors, and success states.
   - Include exact choices/buttons.
   - Include where the user sees the result.
   - Include what the agent should do next.

4. Lock exact data and authority behavior:
   - State what is persisted, where it is persisted, and what is not persisted.
   - State who owns durable authority.
   - State what is runtime-only.
   - State what must be rejected, not migrated or silently remapped.

5. Lock provider/channel behavior:
   - Define the provider-neutral message once.
   - Define provider-specific rendering labels only when necessary.
   - Adapters may change layout, not meaning, authority, or choices.

6. Lock validation:
   - Acceptance criteria must be testable.
   - Include focused unit tests, integration tests, cleanup searches, and manual/runtime smoke checks where relevant.
   - Include webhook/ingress validation when external systems or async responses are involved.

## Required Plan Shape

Return a `<proposed_plan>` block with these sections:

- Title
- Summary
- Exact UX Contract
- Implementation Changes
- Acceptance Criteria
- Test Plan
- Surface Impact Matrix
- Locked Decisions

## Surface Impact Matrix

Always classify these surfaces:

- Runtime behavior
- `settings.yaml`
- Postgres/runtime projection
- Control API
- SDK/contracts
- CLI
- Gantry MCP tools/admin skill
- Channel/provider adapters
- Docs/prompts
- Audit/events
- Tests/verification

Use only these statuses:

- Changed
- Read-only/observable
- Unchanged by design
- Deferred
- Not applicable

Every `Unchanged by design`, `Deferred`, or `Not applicable` entry must include a reason.

## Quality Bar

A good plan has no hidden defaults.

Before finalizing, check:

- Can an implementer write code without asking what the UX copy should say?
- Can an implementer write tests without asking what success means?
- Can an implementer tell what is persisted and what is runtime-only?
- Can an implementer tell what must be rejected?
- Can an implementer tell whether each provider should behave the same?
- Can a product manager understand what the user will see?

If any answer is no, revise the plan before returning it.
