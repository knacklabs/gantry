# GH-408 verification record

This record closes GitHub issue 408 against the DOCS-001 branch baseline
`d1e6dd06`. It maps each acceptance criterion to repository evidence and keeps
environment limits separate from passing proof.

## Acceptance evidence

| Criterion                                                                     | Implementation evidence                                                                                                                                                                                                                              | Verification evidence                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. One indexed engineering section covers all required topics.                | [Engineering standards](README.md) indexes 11 focused policies for source organization, coding, architecture, testing, dependencies, contracts, errors/observability, configuration/secrets, persistence/migrations, performance, and documentation. | `scripts/check_documentation.py` requires the index and complete policy set; all 63 checker tests pass.                                                                   |
| 2. Policies distinguish mechanical checks, review rules, and recommendations. | Every required policy contains explicit **Mechanical**, **Review**, and **Recommendation** rules with repository owners or enforcement links.                                                                                                        | The engineering-contract checker rejects a missing classification; focused tests cover the rule.                                                                          |
| 3. Taxonomy, precedence, ADRs, plans, and history are explicit.               | [Documentation governance](documentation.md), [decision lifecycle](../decisions/README.md), [architecture index](../architecture/README.md), and plan frontmatter define lifecycle and authority.                                                    | The documentation checker validates taxonomy markers, ADR status and supersession, plan ownership/status, and historical-index exclusions.                                |
| 4. Deterministic checks cover governance and repository consistency.          | `scripts/check_documentation.py`, its focused test suite, `npm run docs:check`, and `npm run check:architecture` cover links, identity, policy completeness, lifecycle metadata, taxonomy, generated evidence, and source boundaries.                | `npm run docs:check`, `npm run check:architecture`, and 63 checker unit tests pass.                                                                                       |
| 5. CI runs documentation checks independently.                                | `.github/workflows/ci.yml` contains a standalone Documentation check step, separate from Architecture check.                                                                                                                                         | Workflow inspection and `npm run docs:check` prove the invoked command exists and passes.                                                                                 |
| 6. Contributor and repository entry points are authoritative.                 | `CONTRIBUTING.md` contains environment setup, workflow, a risk-based validation matrix, contracts, migrations, generated-file rules, and PR readiness; root and docs indexes link the canonical standards.                                           | Prettier, documentation links, and `git diff --check` pass.                                                                                                               |
| 7. Every governed record is classified.                                       | `docs/documentation-inventory.json` records category, lifecycle, authority, and intended action for all governed architecture, implementation, feature, decision, and plan paths.                                                                    | Exact-set audit reports 251 actual and 251 listed files, with no missing, extra, duplicate, or incomplete records.                                                        |
| 8. DOCS-001 remains intact, discoverable, reproducible, and completed.        | Existing explorer/atlas links remain in the root and docs indexes; the completed plan now has `status: completed`.                                                                                                                                   | `git diff --quiet d1e6dd06..HEAD -- index.html docs/index.html docs/architecture/atlas` passes; `docs:check` verifies all five Archify pairs and their delivery evidence. |
| 9. Runtime and product behavior is unaffected.                                | The branch changes documentation, repository checks/CI metadata, and one portable factory-write fallback test only; no runtime, API, schema, migration, CLI, provider, channel, permission, or product implementation file changes.                  | Architecture checks, formatting, documentation checks, focused checker tests, the factory regression test, and whitespace checks pass.                                    |

## Final surface review

| Surface                            | Classification      | Branch evidence                                                                                                                                                           |
| ---------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior                   | Unchanged by design | No file under `apps/core`, `apps/web`, or another runtime implementation path differs from the DOCS-001 baseline.                                                         |
| `settings.yaml`                    | Unchanged by design | Neither settings authority nor desired-state configuration changes on this branch.                                                                                        |
| Postgres/runtime projection        | Unchanged by design | No schema, migration, repository, projection, or persistence implementation changes.                                                                                      |
| Control API                        | Unchanged by design | No controller, route, OpenAPI, or control-plane implementation changes.                                                                                                   |
| SDK/contracts                      | Unchanged by design | No SDK package, shared contract, or public type changes.                                                                                                                  |
| CLI                                | Unchanged by design | Existing CLI behavior and command implementations are untouched.                                                                                                          |
| Gantry MCP tools/admin skill       | Unchanged by design | No MCP tool, admin skill, or capability implementation changes.                                                                                                           |
| Channel/provider adapters          | Unchanged by design | No channel, provider, credential, browser, or delivery adapter changes.                                                                                                   |
| Docs/prompts                       | Changed             | Engineering policy, contributor entry points, lifecycle metadata, and the governed-document inventory are the intended branch output; factory prompt files are unchanged. |
| Audit/events                       | Unchanged by design | No runtime audit schema, event contract, outbox, or event handling changes.                                                                                               |
| Tests/verification                 | Changed             | Documentation-governance tests and deterministic checks prove the new repository contract; one factory test covers the portable write fallback used by verification.      |
| DOCS-001 static explorer and atlas | Unchanged by design | `index.html`, `docs/index.html`, and `docs/architecture/atlas` have no diff from baseline `d1e6dd06`; only the completed plan lifecycle marker changed.                   |

## Verification snapshot

Passed on 2026-08-21:

- `npm run docs:check` — 35 public files and five verified Archify pairs.
- `npm run check:architecture`.
- `npm run format:check`.
- `python3 -m unittest scripts.test_check_documentation` — 63 tests.
- `python3 -m pytest -q factory/tests/test_gates.py::test_safe_factory_fd_degrades_when_dir_fd_is_unavailable` — one test.
- exact documentation-inventory set audit — 251/251 paths.
- `git diff --check`.
- DOCS-001 explorer and atlas unchanged check against `d1e6dd06`.

The checkout volume had less than 1 GB free, so a full `npm ci` could not be
retained and broad lint, typecheck, runtime test, build, and image suites were
not rerun. The documentation checks used an isolated temporary install of the
three declared parser/formatter dependencies and left no `node_modules` or
generated output in the worktree. This limitation does not replace CI; CI must
run the repository's normal code suites before merge.

## Scope confirmation

No acceptance criterion required a new runtime contract or architecture
decision. The work documents and enforces the existing source boundaries,
retains context-only history in place, and does not promote historical claims
to current architecture.
