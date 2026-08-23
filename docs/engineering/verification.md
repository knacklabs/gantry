# GH-408 verification record

This record closes GitHub issue 408 on top of current `main` at `6c3f8293`
while preserving the DOCS-001 baseline at `d1e6dd06`. It maps each acceptance
criterion to repository evidence and keeps environment limits separate from
passing proof.

## Acceptance evidence

| Criterion                                                                     | Implementation evidence                                                                                                                                                                                                                              | Verification evidence                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. One indexed engineering section covers all required topics.                | [Engineering standards](README.md) indexes 11 focused policies for source organization, coding, architecture, testing, dependencies, contracts, errors/observability, configuration/secrets, persistence/migrations, performance, and documentation. | `scripts/check_documentation.py` requires the index and complete policy set; all 65 checker tests pass.                                                                   |
| 2. Policies distinguish mechanical checks, review rules, and recommendations. | Every required policy contains explicit **Mechanical**, **Review**, and **Recommendation** rules with repository owners or enforcement links.                                                                                                        | The engineering-contract checker rejects a missing classification; focused tests cover the rule.                                                                          |
| 3. Taxonomy, precedence, ADRs, plans, and history are explicit.               | [Documentation governance](documentation.md), [decision lifecycle](../decisions/README.md), [architecture index](../architecture/README.md), and plan frontmatter define lifecycle and authority.                                                    | The documentation checker validates taxonomy markers, ADR status and supersession, plan ownership/status, and historical-index exclusions.                                |
| 4. Deterministic checks cover governance and repository consistency.          | `scripts/check_documentation.py`, its focused test suite, `npm run docs:check`, and `npm run check:architecture` cover links, identity, policy completeness, lifecycle metadata, taxonomy, generated evidence, and source boundaries.                | `npm run docs:check`, `npm run check:architecture`, and 65 checker unit tests pass.                                                                                       |
| 5. CI runs documentation checks independently.                                | `.github/workflows/ci.yml` contains a standalone Documentation check step, separate from Architecture check.                                                                                                                                         | Workflow inspection and `npm run docs:check` prove the invoked command exists and passes.                                                                                 |
| 6. Contributor and repository entry points are authoritative.                 | `CONTRIBUTING.md` contains environment setup, workflow, a risk-based validation matrix, contracts, migrations, generated-file rules, and PR readiness; root and docs indexes link the canonical standards.                                           | Prettier, documentation links, and `git diff --check` pass.                                                                                                               |
| 7. Every governed record is classified.                                       | `docs/documentation-inventory.json` records category, lifecycle, authority, and intended action for all governed architecture, implementation, feature, decision, and plan paths, including records added by current `main`.                         | Exact-set audit reports 310 actual and 310 listed files, with no missing, extra, duplicate, or incomplete records.                                                        |
| 8. DOCS-001 remains intact, discoverable, reproducible, and completed.        | Existing explorer/atlas links remain in the root and docs indexes; the completed plan now has `status: completed`.                                                                                                                                   | `git diff --quiet d1e6dd06..HEAD -- index.html docs/index.html docs/architecture/atlas` passes; `docs:check` verifies all five Archify pairs and their delivery evidence. |
| 9. Runtime and product behavior is unaffected.                                | The branch changes documentation and repository checks/CI metadata only; no runtime, API, schema, migration, CLI, provider, channel, permission, or product implementation file changes.                                                             | Architecture checks, formatting, documentation checks, focused checker tests, and whitespace checks pass.                                                                 |

## Final surface review

| Surface                            | Classification      | Branch evidence                                                                                                                                                      |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior                   | Unchanged by design | No file under `apps/core`, `apps/web`, or another runtime implementation path differs from current `main`; upstream runtime changes are inherited through the merge. |
| `settings.yaml`                    | Unchanged by design | Neither settings authority nor desired-state configuration changes on this branch.                                                                                   |
| Postgres/runtime projection        | Unchanged by design | No schema, migration, repository, projection, or persistence implementation changes.                                                                                 |
| Control API                        | Unchanged by design | No controller, route, OpenAPI, or control-plane implementation changes.                                                                                              |
| SDK/contracts                      | Unchanged by design | No SDK implementation, shared contract, or public type changes; package metadata changes only correct canonical repository links.                                    |
| CLI                                | Unchanged by design | Existing CLI behavior and command implementations are untouched.                                                                                                     |
| Gantry MCP tools/admin skill       | Unchanged by design | No MCP tool, admin skill, or capability implementation changes.                                                                                                      |
| Channel/provider adapters          | Unchanged by design | No channel, provider, credential, browser, or delivery adapter changes.                                                                                              |
| Docs/prompts                       | Changed             | Engineering policy, contributor entry points, lifecycle metadata, and the governed-document inventory are the intended branch output.                                |
| Audit/events                       | Unchanged by design | No runtime audit schema, event contract, outbox, or event handling changes.                                                                                          |
| Tests/verification                 | Changed             | Documentation-governance tests and deterministic checks prove the new repository contract.                                                                           |
| DOCS-001 static explorer and atlas | Unchanged by design | `index.html`, `docs/index.html`, and `docs/architecture/atlas` have no diff from baseline `d1e6dd06`; only the completed plan lifecycle marker changed.              |

## Verification snapshot

Passed on 2026-08-21:

- `npm run docs:check` — 36 public files and five verified Archify pairs.
- `npm run check:architecture`.
- `npm run format:check`.
- `npm run typecheck`.
- `npm run test:unit` — 664 test files and 8,915 tests.
- `python3 -m unittest scripts.test_check_documentation` — 65 tests.
- exact documentation-inventory set audit — 310/310 paths after integrating current `main`.
- `git diff --check`.
- DOCS-001 explorer and atlas unchanged check against `d1e6dd06`.

The checkout volume had less than 1 GB free, so a fresh full `npm ci` could not
be retained. Type checking and the complete runtime unit suite were run with an
existing compatible dependency tree. `npm run lint` reaches pre-existing
current-`main` unused-code failures in runtime files that this branch does not
change. The web suite could not be reproduced locally because no available
dependency tree contained the current web workspace dependencies. Documentation
checks used an isolated temporary install of the three declared
parser/formatter dependencies. These environment and upstream-baseline limits
do not replace CI; CI must run the repository's normal lint, web, build, and
image suites before merge.

## Scope confirmation

No acceptance criterion required a new runtime contract or architecture
decision. The work documents and enforces the existing source boundaries,
retains context-only history in place, and does not promote historical claims
to current architecture.
