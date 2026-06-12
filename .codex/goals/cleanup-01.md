Title: Provider Boundary Architecture Gates Before Claude Isolation

  Repository: /Users/dev/Workdir/myclaw

  Start a fresh factory run for this goal. ENG-123 is already done; do not reuse its completed state.

  Operating contract:
  - Follow WORKFLOW.md, docs/FACTORY.md, docs/QUALITY.md, and .codex/prompts/planner.md.
  - Use the planner and decomposer prompts before implementation.
  - Do not move runtime code.
  - Do not implement Codex.
  - Do not change runtime behavior.
  - This is a gate-only PR that makes future provider leakage fail early.
  - Keep code maintainable: no duplicated rule logic, no broad allowlists, no dead fixtures, no tmp files, no legacy compatibility shims.
  - Update docs/architecture/framework-boundaries.md and root AGENTS.md with the new provider-boundary lesson, keeping AGENTS concise and non-
  duplicative.

  Problem

  The architecture checker still allows Claude/Anthropic provider concerns to leak into runtime, memory, CLI, config, and shared model catalog code.

  Current evidence:
  - .codex/architecture-map.json allows provider-specific paths such as apps/core/src/config, apps/core/src/cli, apps/core/src/runner/claude, apps/core/
  src/memory/claude-query.ts, and apps/core/src/shared/model-catalog.ts.
  - .codex/scripts/architecture_rules.py allows Anthropic SDK imports in runner/claude and memory/claude-query.ts.
  - .codex/architecture-exceptions.json waives existing memory Claude import debt too broadly.
  - docs/architecture/framework-boundaries.md documents the old exception.

  Scope / Non-goals

  In scope:
  - Define apps/core/src/adapters/llm/** as the only approved provider SDK import boundary.
  - Add architecture gates for Anthropic SDK imports outside that boundary.
  - Add architecture gates for provider-specific terms outside approved adapter or migration documentation paths.
  - Add regression tests with fixtures proving memory, runtime, application, and domain leaks fail.
  - Replace broad existing exceptions with narrow, named, temporary migration exceptions only where the current tree still needs them.
  - Clean up stale broad allowlist entries, duplicated rule patterns, old exception wording, and docs that describe the old boundary.

  Non-goals:
  - Do not move apps/core/src/runner/claude code yet.
  - Do not implement Codex provider support.
  - Do not rename runtime env vars or change runtime behavior.
  - Do not add compatibility layers for old provider paths.
  - Do not make docs/tests impossible to write by banning provider terms in rule definitions, fixtures, or migration docs.

  Acceptance Criteria

  1. New architecture rule makes apps/core/src/adapters/llm/** the only normal provider SDK import boundary.
  2. Anthropic SDK imports fail from memory, runtime, application, domain, config, CLI, and shared model catalog code unless covered by a narrow
  temporary migration exception.
  3. Tests prove an Anthropic SDK import in apps/core/src/memory/break.ts fails.
  4. Tests prove Anthropic SDK imports from runtime/application/domain fixture paths fail.
  5. Tests prove CLAUDE_CONFIG_DIR, ANTHROPIC_*, claude-jsonl, and runner/claude references fail outside approved provider adapter paths, architecture
  rule/test fixtures, or migration docs.
  6. .codex/architecture-map.json no longer treats apps/core/src/config, apps/core/src/cli, apps/core/src/runner/claude, apps/core/src/memory/claude-
  query.ts, or apps/core/src/shared/model-catalog.ts as approved long-term provider import locations.
  7. .codex/architecture-exceptions.json keeps only exact-file, migration-named, temporary exceptions with removal phase and reason.
  8. docs/architecture/framework-boundaries.md describes the target boundary and clearly labels any remaining exception as temporary migration debt.
  9. Root AGENTS.md receives a concise provider-boundary best-practice update or link, without duplicating the full architecture doc.
  10. npm run check:architecture passes on the current tree while still failing the new synthetic bad fixtures.
  11. python3 .codex/scripts/tests/test_check_architecture.py passes.
  12. python3 .codex/scripts/check_task_completion.py passes or reports only unrelated pre-existing blockers with exact evidence.

  Technical Approach

  - Inspect .codex/architecture-map.json, .codex/scripts/architecture_rules.py, .codex/architecture-exceptions.json, docs/architecture/framework-
  boundaries.md, and existing architecture tests before editing.
  - Centralize provider boundary data in architecture_rules.py so import allowlist and forbidden-term checks do not drift.
  - Treat provider-specific SDK imports as allowed only under apps/core/src/adapters/llm/**, plus exact temporary migration exceptions.
  - Add forbidden provider-term checks for:
    - CLAUDE_CONFIG_DIR
    - ANTHROPIC_* style names
    - claude-jsonl
    - runner/claude path references
  - Allow those terms only in:
    - apps/core/src/adapters/llm/**
    - .codex/scripts/architecture_rules.py
    - .codex/scripts/tests/** fixtures/expected diagnostics
    - docs/architecture/** migration documentation where explicitly labeled
    - exact temporary exception entries
  - Use fixture-style tests, not production test-only branches.
  - Keep diagnostics clear enough that a future contributor knows where provider-specific code belongs.

  Task Decomposition

  Task 1: Baseline and rule design
  Objective: Map existing provider-boundary checks and decide the narrow exception model.
  Write scope: read-only.
  Dependencies: none.
  Acceptance criteria:
  - Current approved provider paths are listed.
  - Current exception entries are listed.
  - Exact target allowlist and exception names are decided.
  Verify commands:
  - python3 .codex/scripts/stage_orchestrator.py
  - rg -n "Anthropic|@anthropic|CLAUDE_CONFIG_DIR|ANTHROPIC_|claude-jsonl|runner/claude" .codex apps/core/src docs/architecture
  Reviewer focus:
  - No hidden broad allowlist remains in the design.

  Task 2: Tighten provider SDK import boundary
  Objective: Restrict provider SDK imports to apps/core/src/adapters/llm/** plus exact temporary migration exceptions.
  Write scope:
  - .codex/architecture-map.json
  - .codex/scripts/architecture_rules.py
  - .codex/architecture-exceptions.json
  Dependencies: Task 1.
  Required tests:
  - Update or add test_anthropic_import_outside_provider_adapter_fails.
  - Add fixture coverage for memory, runtime, application, and domain paths.
  Verify commands:
  - python3 .codex/scripts/tests/test_check_architecture.py
  - npm run check:architecture
  Reviewer focus:
  - No generic config, CLI, runtime, memory, runner, or shared catalog provider SDK allowlist remains.

  Task 3: Add forbidden provider-term gates
  Objective: Catch provider-specific identifiers outside approved adapter/migration surfaces.
  Write scope:
  - .codex/scripts/architecture_rules.py
  - .codex/scripts/tests/test_check_architecture.py
  Dependencies: Task 2.
  Required tests:
  - Fixture test for CLAUDE_CONFIG_DIR in a runtime file.
  - Fixture test for ANTHROPIC_* in application/config-style code.
  - Fixture test for claude-jsonl in memory/runtime code.
  - Fixture test for runner/claude path reference outside migration docs.
  Verify commands:
  - python3 .codex/scripts/tests/test_check_architecture.py
  Reviewer focus:
  - Tests should not accidentally ban rule definitions, test fixtures, or explicitly labeled migration docs.

  Task 4: Documentation and cleanup
  Objective: Remove stale boundary language and document the new target boundary.
  Write scope:
  - docs/architecture/framework-boundaries.md
  - AGENTS.md
  - .codex/architecture-exceptions.json
  Dependencies: Tasks 2 and 3.
  Acceptance criteria:
  - Docs say provider SDK code belongs under apps/core/src/adapters/llm/**.
  - Existing Claude exceptions are named as temporary migration debt with removal phase.
  - AGENTS.md has a short best-practice note or doc pointer, not a duplicate policy block.
  - Broad old allowlist paths are removed.
  - No dead fixture files or temporary scratch files remain.
  Verify commands:
  - rg -n "runner/claude|memory/claude-query|CLAUDE_CONFIG_DIR|ANTHROPIC_|claude-jsonl|@anthropic" .codex apps/core/src docs/architecture AGENTS.md
  - npm run check:architecture
  Reviewer focus:
  - Cleanup is real, not just hidden behind exceptions.

  Task 5: Final verification and PR readiness
  Objective: Prove this gate-only PR is safe and ready for review.
  Write scope:
  - .factory artifacts only if required by the active factory phase.
  Dependencies: Tasks 1-4.
  Verify commands:
  - python3 .codex/scripts/tests/test_check_architecture.py
  - npm run check:architecture
  - python3 .codex/scripts/verify.py
  - python3 .codex/scripts/validate_artifacts.py --allow-missing-run
  - python3 .codex/scripts/check_task_completion.py
  Reviewer focus:
  - CI can detect new provider leakage before code movement starts.

  Surface Impact Matrix

  runtime behavior: Unchanged by design — architecture gates only.
  settings.yaml: Unchanged by design — no settings writes or projection changes.
  Postgres/runtime projection: Unchanged by design — no schema/runtime projection changes.
  control API: Unchanged by design.
  SDK/contracts: Unchanged by design — no public contract behavior change.
  CLI: Read-only/observable — CLI paths become subject to stricter architecture checks.
  MyClaw MCP tools/admin skill: Unchanged by design.
  channel/provider adapters: Read-only/observable — apps/core/src/adapters/llm/** becomes the explicit provider SDK boundary.
  docs/prompts: Changed — framework boundary docs and AGENTS guidance updated.
  audit/events: Unchanged by design.
  tests/verification: Changed — architecture tests and fixtures updated.

  Risks

  - The gate may fail on current code before provider isolation moves happen.
    Mitigation: use exact-file, migration-named temporary exceptions with removal phase and no wildcard expansion.

  - Forbidden term checks may block legitimate tests or docs.
    Mitigation: explicitly allow architecture tests, rule definitions, and labeled migration docs.

  - Rule logic may become duplicated between import checks and term checks.
    Mitigation: centralize approved provider-boundary paths and migration exception handling.

  - Broad exceptions may hide future leakage.
    Mitigation: no directory-wide exception for runtime, memory, CLI, config, runner, or shared catalog provider terms.

  Verify Plan

  Run, in order:
  1. python3 .codex/scripts/stage_orchestrator.py
  2. python3 .codex/scripts/tests/test_check_architecture.py
  3. npm run check:architecture
  4. python3 .codex/scripts/verify.py
  5. python3 .codex/scripts/validate_artifacts.py --allow-missing-run
  6. python3 .codex/scripts/check_task_completion.py

  Done Means

  - The current tree passes the architecture checker through narrow temporary exceptions only.
  - New provider leakage in memory/runtime/application/domain/config/CLI/shared catalog fails.
  - The target boundary apps/core/src/adapters/llm/** is explicit in rules, tests, exceptions, and docs.
  - Cleanup removes broad allowlist debt instead of hiding it.
  - The PR is gate-only and ready for the later provider-isolation implementation work.