# Documentation governance

Documentation has one purpose per location:

- `docs/product/`: product intent and adoption.
- `docs/architecture/`: curated current-system context, boundaries, flows,
  invariants, and deployment architecture.
- `docs/implementation/`: difficult current implementation detail linked to
  source ownership.
- `docs/features/`: supported behavior from the user's perspective.
- `docs/decisions/`: proposed, accepted, or superseded architectural decisions.
- `docs/engineering/`: the repository quality contract.
- `docs/operations/`, `docs/security/`, and `docs/reference/`: operator,
  security, and stable reference material.
- `plans/active/`: proposed, approved, or in-progress future work.
- `plans/completed/`: completed historical plans; `plans/archive/`: abandoned
  historical plans.

Authority is implementation/tests → accepted current ADRs → current
architecture/implementation docs → feature docs → active plans → history.
A completed plan does not become architecture. Historical prompts, audits,
reviews, validations, drafts, migrations, and handoffs remain context only
unless current docs independently verify and adopt their claims.

Behavior changes update their authoritative docs in the same PR. ADRs use
`proposed | accepted | superseded`; superseded records identify replacements.
Plans use `proposed | approved | in-progress | completed | abandoned` and
include issue/title ownership metadata. Generated docs identify source,
revision, tool/version, and regeneration workflow.

**Mechanical:** `npm run docs:check` validates public links, evidence,
engineering completeness, lifecycle metadata, taxonomy/indexes, and repository
identity.

**Review:** Reviewers verify source claims, authority, lifecycle, discoverability,
security redaction, examples, and whether duplicate sources of truth were added.

**Recommendation:** Link to authoritative detail instead of copying it. Preserve
historical paths unless a verified migration updates every inbound link.
