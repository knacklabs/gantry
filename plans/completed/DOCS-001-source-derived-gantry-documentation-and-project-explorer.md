---
issue: DOCS-001
title: Source-derived Gantry documentation and project explorer
status: completed
saved: 2026-07-27T08:44:44+00:00
---

# DOCS-001 — Source-derived Gantry documentation and project explorer

## Problem

Current onboarding and architecture documents contain repository URLs and
runtime claims that no longer match the implementation on `main`. The
repository also lacks a single static, visual entry point for developers, and
its Markdown/HTML corpus contains broken relative links. Existing historical
documents remain valuable evidence, so the change must repair navigation
without rewriting their historical meaning.

## Scope / Non-goals

In scope:

- derive current architecture, features, flows, supported providers, public
  APIs, storage boundaries, deployment roles, and verification status from
  source code, executable registries, schemas, and tests;
- create a self-contained root `index.html`, a detailed codebase guide, and a
  clear record of audit coverage and environment-dependent verification limits;
- refresh active README, architecture, SDK, and package-repository metadata;
- repair all relative-link failures found by the repository-wide documentation
  checker while preserving historical prose;
- record passing checks and verification limits honestly without turning
  inherited repository findings into a contributor-owned bug ledger.

Non-goals:

- changing runtime behavior, schemas, APIs, CLI behavior, or dependency
  versions;
- fixing the runtime lint errors or production dependency advisories reported
  by this audit;
- rewriting old decisions, reviews, plans, or migrated context to describe
  current behavior;
- enabling GitHub Pages or another production hosting service.

## Acceptance Criteria

1. Every tracked file is read byte-for-byte, every JavaScript/TypeScript source
   parses, and the coverage statistics are recorded.
2. `index.html` renders at desktop and mobile widths without document-level
   horizontal overflow; search, navigation, and expandable feature content
   work without console errors.
3. The codebase guide explains boot, inbound work, execution surfaces, model
   routing, channels, permissions, credentials, browser, memory, storage,
   delivery, deployment roles, API, CLI, and repository layout from code.
4. The codebase guide distinguishes completed audit coverage from
   environment-dependent verification limits; this documentation-only change
   does not publish inherited repository findings as a new `bug.md` ledger.
5. Active onboarding and architecture pages do not advertise Teams as a live
   runtime transport or threads as a durable-memory partition.
6. Repository and package metadata point to `knacklabs/gantry`.
7. Every relative Markdown/HTML link in the checked repository corpus resolves
   after repairing historical link syntax without changing historical meaning.
8. Architecture checks, type checking, all unit tests, and the complete build
   pass; unrelated repository-wide lint and dependency remediation remain
   outside this documentation-only change.

## Technical Approach

1. Use the TypeScript parser and a byte-level tracked-file scanner to inventory
   the repository. Trace behavior from entry points, registries, route
   construction, schemas, adapters, and tests.
2. Keep current-behavior documentation centralized in
   `docs/CODEBASE_GUIDE.md`; make README and active architecture pages concise
   entry points rather than duplicating the full guide.
3. Keep `index.html` dependency-free with embedded CSS and JavaScript so it can
   be opened from a checkout or served by any static host. Link source-code
   paths to the canonical GitHub repository.
4. Repair broken historical links mechanically: convert line-suffixed file
   targets to GitHub-compatible relative paths and `#L<number>` fragments,
   correct root-relative intent in migrated context, and leave surrounding
   historical claims unchanged.
5. Validate all relative links with one repository-wide checker, then run the
   repository checks and functional browser checks.

The simpler shape is one static HTML file plus Markdown, with no framework,
asset pipeline, Pages workflow, or documentation generator. That is sufficient
for the approved deliverable and avoids introducing infrastructure.

## Decisions

- [0135-docs-001-client-signoff](../../docs/decisions/0135-docs-001-client-signoff.md) records
  Yash's approval of the source-derived deliverables and historical-link repair
  boundary.
- No additional product or architecture decisions are required.

Completion-scope clarification: after the original sign-off, Yash clarified
that this contributor task should make the documentation current rather than
publish an inherited project bug backlog. Criterion 4 therefore records audit
coverage and environment limits in the guide and explicitly excludes a new
`bug.md`. The original sign-off record remains unchanged as historical evidence.

## Surface Impact

| Surface          | Classification      | Impact                                                                                             |
| ---------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Runtime behavior | Unchanged by design | Documentation and metadata only; no runtime source behavior changes.                               |
| API              | Unchanged by design | The guide describes the generated OpenAPI surface but does not modify it.                          |
| Data/schema      | Unchanged by design | Postgres schemas and migrations are read as evidence only.                                         |
| CLI/ops          | Unchanged by design | CLI and deployment paths are documented but not changed.                                           |
| UI               | Changed             | Adds the self-contained static project explorer.                                                   |
| Docs             | Changed             | Adds the guide and audit-coverage notes, refreshes current entry points, and repairs broken links. |
| Tests            | Read-only           | Existing checks and browser behavior are run; no runtime test source changes are required.         |

## Task Decomposition

1. **Current-state documentation:** finalize the source-derived guide, audit
   coverage and verification limits, active README/architecture corrections,
   and repository metadata.
   Serves criteria 1, 3, 4, 5, 6, and 8.
2. **Static explorer:** finalize the accessible, responsive, dependency-free
   HTML architecture/feature explorer. Serves criterion 2.
3. **Historical navigation repair:** fix every relative-link failure without
   editing historical meaning. Serves criterion 7.
4. **Verification and evidence:** run repository-wide links, formatting,
   architecture, typecheck, unit, build, desktop and mobile functional checks,
   then record the verification outcome. Serves all criteria.

## Risks

- **Historical drift:** broad prose edits could erase evidence. Mitigation:
  limit historical changes to link targets and verify the surrounding prose is
  unchanged.
- **False link failures:** code citations and template placeholders can resemble
  Markdown links. Mitigation: inspect each reported match and exclude
  non-navigation syntax only when it is intentionally literal.
- **Overclaiming coverage:** byte-level reading does not equal human semantic
  proof of every line. Mitigation: state the scanner/parser coverage precisely
  and ground architecture claims in executable boundaries and tests.
- **Inherited red checks:** repository-wide lint or dependency findings can be
  unrelated to a documentation diff. Mitigation: do not label them as
  introduced or passed, and do not create a contributor-owned bug ledger for
  findings outside this task.
- **Static-host assumptions:** a root HTML file is not automatically a live
  GitHub Pages deployment. Mitigation: describe it as a static artifact; hosting
  remains outside this task.

## Verify Plan

1. Re-run the tracked-tree byte scanner and TypeScript parser; compare counts
   and confirm zero parser syntax errors.
2. Run a repository-wide relative-link checker over all Markdown and HTML;
   require zero missing targets.
3. Run Prettier check and `git diff --check`.
4. Run `npm run check:architecture`, `npm run typecheck`,
   `npm run test:unit`, and `npm run build`.
5. Serve `index.html` locally and verify desktop/mobile rendering, no
   document-level horizontal overflow, search filtering, feature expansion,
   navigation targets, and browser console errors.
6. Run deterministic factory verification with repository-specific npm command
   overrides, record automated and functional test artifacts, run one
   autoreview pass for quality/performance/security, and require `pr_ready.py`
   to pass.
