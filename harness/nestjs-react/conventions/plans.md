# Plans
> Canon: <!-- canon: constitution/00-agentic-development-workflow.md --> — this file only adds NestJS-React scaffold specifics.

Plans are first-class artifacts. They live in the repo. Agents read plans to understand what to build, what's in progress, and what was decided.

## Three Plan Types — Don't Confuse Them

| Type | Purpose | Who Writes | Where | Size |
|------|---------|-----------|-------|------|
| **Project BRIEF.md** | WHAT to build | Human | `docs/product/BRIEF.md` | ~1 page |
| **Execution plan** | HOW to build a specific piece | Agent or human | `plans/active/<name>.md` | 1-2 pages |
| **Tech debt** | Known quality gaps | Agent | `plans/debt/<name>.md` | Short |

### Project BRIEF.md — Human Intent (The Input)

This is the starting point. Written by a human. Contains:

- **What** — one paragraph on what we're building and why
- **Who** — 2-4 user types
- **Flows** — 3-7 key user journeys in plain English
- **Domain Concepts** — the nouns and their relationships (not schemas)
- **Constraints** — auth, integrations, deploy target, business rules
- **Out of Scope** — what v1 is NOT

**What BRIEF.md must NOT contain:**

- Prisma schemas or data models (derived from domain concepts)
- API endpoint tables (derived from flows + tasks)
- Page specs or component trees (derived from flows)
- File structures or directory layouts (convention handles this)
- Technology choices already locked in conventions

If you're writing column names in BRIEF.md, you're doing decomposition by hand. Stop.

See `BRIEF_TEMPLATE.md` in the harness root.

### Execution Plans — Build Tracking (The During)

Created AFTER project BRIEF.md exists and decomposition is done. Tracks a specific unit of work. One execution plan per branch/feature.

| Condition | Action |
|-----------|--------|
| Task touches 1-2 files | Lightweight plan (PR description) |
| Task touches 3+ files | Execution plan required |
| New domain or module | Execution plan required |
| Refactor across boundaries | Execution plan required |

Lightweight plans need no file — the PR description IS the plan.

## Directory Structure

```
plans/
  active/          # Currently in progress
  completed/       # Done (archived, never deleted)
  debt/            # Known tech debt, prioritized
  README.md        # Quick reference (points here)
```

## Execution Plan Format

Every execution plan follows this structure:

```markdown
# Plan: <Goal in one sentence>

**Status:** In Progress | Blocked | Complete
**Branch:** feature/issue-NNN-short-description
**Created:** YYYY-MM-DD
**Last updated:** YYYY-MM-DD

## Context

Why this work is happening now. What triggered it — issue, incident, new requirement, tech debt.

## Approach

Ordered steps to complete the work:

1. Step one (specific, actionable)
2. Step two
3. Step three

## Progress

- [x] Step completed (commit: abc1234)
- [ ] Step in progress
- [ ] Step not started

## Decision Log

| Date | Decision | Reasoning |
|------|----------|-----------|
| YYYY-MM-DD | Chose X over Y | Because Z. Future agents: don't revisit this unless <condition>. |

## Risks / Open Questions

- Risk or question (status: resolved/open)

## Completion Criteria

- [ ] All approach steps done
- [ ] Tests passing
- [ ] PR approved and merged
- [ ] Plan moved to completed/
```

## Rules

### When to Create a Plan

| Condition | Action |
|-----------|--------|
| Task touches 1-2 files | Lightweight plan (PR description) |
| Task touches 3+ files | Execution plan required |
| New domain or module | Execution plan required |
| Refactor across boundaries | Execution plan required |

**The plan is committed as the first commit on the branch.** Code comes after.

### Maintaining Plans

- Update progress after each significant step (commit the update alongside the code).
- Decision log captures **WHY**, not just WHAT. Future agents need the reasoning to avoid re-litigating settled decisions.
- If a decision is reversed, log the reversal and the new reasoning. Don't delete the old entry.

### Completing Plans

- When all completion criteria are met, move the file from `active/` to `completed/`.
- Add a final decision log entry summarizing the outcome.
- Completed plans are **never deleted**. They are the versioned history of how the codebase evolved.

### Tech Debt Plans

- Created when an agent identifies a quality issue but the fix is out of scope for the current task.
- Each debt plan links to the relevant entry in `quality-grades.md`.
- Include: what's wrong, why it matters, estimated scope, and suggested approach.
- Prioritize by impact: `critical > high > medium > low`.

## Agent Behavior

### Before Starting Work

1. Check `plans/active/` for related plans.
2. If a related plan exists, **continue it** — don't create a duplicate.
3. If a plan exists but is stale (no progress commit in 3+ days), flag it in the decision log and assess whether to continue or supersede it.

### During Work

1. Commit plan creation as the first commit on the branch.
2. Update progress checkboxes after each significant step.
3. Log every non-obvious decision with reasoning.
4. If scope changes, update the approach section and log why.

### After Work

1. Verify all completion criteria are met.
2. Move plan from `active/` to `completed/`.
3. If new tech debt was discovered, create a debt plan.

## Sample Execution Plan

```markdown
# Plan: Add Stripe webhook handling for subscription lifecycle

**Status:** In Progress
**Branch:** feature/issue-87-stripe-webhooks
**Created:** 2025-03-10
**Last updated:** 2025-03-11

## Context

Subscription renewals, cancellations, and payment failures are invisible. Triggered by issue #87.

## Approach

1. Create StripeWebhookController with signature verification
2. Add event handlers: checkout.session.completed, invoice.paid, 
   customer.subscription.deleted, invoice.payment_failed
3. Create SubscriptionService to update user subscription state
4. Add idempotency tracking (webhook_events table)
5. Write integration tests with Stripe test fixtures

## Progress

- [x] StripeWebhookController with signature verification (commit: a1b2c3d)
- [x] Event handlers for all four event types (commit: e4f5g6h)
- [ ] SubscriptionService implementation
- [ ] Idempotency tracking
- [ ] Integration tests

## Decision Log

| Date | Decision | Reasoning |
|------|----------|-----------|
| 2025-03-10 | Raw body parsing for webhook route only | Stripe requires raw body for sig verification. Scoped to /webhooks/stripe. |
| 2025-03-11 | Separate webhook_events table | Idempotency tracks ALL event types, not just subscriptions. Dedicated table. |

## Risks / Open Questions

- Webhook replay during deploys (open)

## Completion Criteria

- [ ] All Stripe events handled and tested
- [ ] Idempotent processing, signature verification in place
- [ ] PR approved and merged, plan moved to completed/
```

## CI Integration

Lint rule: fail PR if branch modifies 3+ source files with no execution plan in `plans/active/`.

> "PLAN_REQUIRED: This branch modifies {{count}} files but has no plan in plans/active/. See conventions/plans.md"
