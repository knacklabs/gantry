---
slug: gh-408-engineering-standards-and-documentation-governance
title: Repository engineering standards and documentation governance
status: confirmed
saved: 2026-08-21
---

# Repository engineering standards and documentation governance

## Capability

Gantry provides a tool-agnostic, source-aligned engineering contract that lets
contributors understand where code belongs, which boundaries apply, what proof
a change needs, and which documents are authoritative without reconstructing
the answer from history or maintainer automation.

## Required outcomes

1. `docs/engineering/README.md` is the canonical engineering entry point and
   indexes explicit policies for source organization, coding, architecture,
   testing, dependencies, contracts, errors and observability, configuration
   and secrets, persistence and migrations, performance, and documentation.
2. Each policy separates mechanically enforced rules, review requirements,
   and recommendations, and identifies concrete source or enforcement owners.
3. The repository's domain, application, adapter, runtime, CLI, persistence,
   provider, channel, SDK, contract, and cross-cutting boundaries are described
   from the current source tree.
4. Documentation taxonomy and precedence distinguish current architecture,
   implementation detail, supported features, accepted decisions, active
   plans, generated artifacts, and historical context.
5. ADR and plan lifecycle metadata is explicit and mechanically validated.
6. Deterministic checks detect missing policies, invalid lifecycle state,
   historical work indexed as current architecture, broken public links, and
   canonical repository metadata drift.
7. `CONTRIBUTING.md` documents the real environment, workflow, validation
   matrix, migrations, contracts, generated files, and review readiness.
8. Root and documentation indexes link the engineering contract without
   displacing the existing DOCS-001 project explorer or its architecture
   atlas.
9. Every governed architecture, implementation, feature, decision, and plan
   record has an inventory category, lifecycle, authority, and intended action.

## Authority and safety constraints

- Current source and tests outrank documentation; accepted current decisions
  outrank explanatory documents; current architecture and implementation docs
  outrank feature summaries; active plans outrank historical context only for
  intended future work.
- Automation enforces policy but does not define it. Canonical engineering docs
  must remain understandable without Gantry's factory or a particular agent.
- Historical prompts, audits, plans, validations, reviews, and handoffs remain
  context only. Preserve them and their links unless a separately verified
  migration provides equal historical traceability.
- Documentation classification must not upgrade an unverified historical claim
  into current runtime truth.
- Existing runtime behavior, API, database schema, CLI, settings, providers,
  channels, permissions, and package contracts remain unchanged.

## Validation

- Focused documentation-checker unit tests cover every new governance rule.
- `npm run docs:check`, `npm run check:architecture`, formatting, and factory
  verification pass.
- The final evidence maps every GitHub issue #408 acceptance criterion to a
  file or deterministic check.

## Non-goals

- Reformatting or refactoring runtime code for stylistic consistency.
- Bulk-moving or deleting historical documentation.
- Replacing the DOCS-001 static explorer, diagrams, or adoption material.
- Mandating a contributor's editor, model, agent, or development harness.
