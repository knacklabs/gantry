# Native discussion reliability handoff

Scope: local Gantry source only. No DEV access, deployment, paid model call or PR merge was performed. The original dirty hotfix checkout was preserved unchanged. This branch starts at capacity correction `48d8aa70b`.

## Integrated repairs

- Native caller tools return an explicit exhausted-budget result. Ordinary jobs retain their previous failure behavior. The caller still sets the interaction limit.
- Native document tasks reach signed operation authorization without requiring an unrelated static conversation registration. Same-chat target, signed proof and current source scope remain mandatory.
- The document tool checks the unchanged renderer contract before execution. Invalid tables, names and aggregate content produce a correctable result instead of a failed rendering attempt.
- Native chat admission, summaries and learning checks use catalog workload and capability information. They no longer require a Haiku model name or a Luna rehearsal environment flag. Credential and application authorization remain separate mandatory checks.
- Native requests do not use model-family fallback when choosing their first provider. Invalid settings or credentials fail rather than selecting another provider.
- Summary token counting now carries the same configured model profile as the summary request. Previously the alias alone could send an OpenAI request to the default Anthropic counter.
- OpenAI tool-free summary/learning requests use a bounded Responses request without testing flags or an unconditional provider-specific reasoning setting. Other compatible memory transports retain their existing route. Exact model identity is carried in the request profile.
- The committed shared host-capacity correction remains included. Real concurrent recipe/research/chat acceptance is still required; unit tests alone do not establish host throughput.

## Historical evidence limits

The locally retained acceptance report records eleven structured-output parsing failures and one learning-provenance rejection. It does not retain their actual invalid JSON, exact validator errors or proposed learning text. Their individual causes cannot be classified from those counts. These failures remain unresolved evidence gaps. Strict output, grounding and learning checks were preserved. New native failures retain bounded private diagnostics before rethrowing the unchanged validation failure. Host diagnostics live under DATA_DIR/private-source-diagnostics. Sandbox runner diagnostics use GANTRY_IPC_DIR/private-source-diagnostics inside the existing private IPC area. Match them by run ID. Records preserve complete output up to 64 KiB. Larger outputs get an explicit omitted marker, byte count and SHA256. Credential redaction is marked. Validator paths and selected source IDs are retained with explicit overflow markers. Directories use 0700 and files use 0600. Retention cleanup runs on capture and keeps at most 20 records for 24 hours per directory. Existing IPC lifecycle cleanup still applies. No raw content is added to public events or logs.

The historical pre-bid renderer failure also lacks its exact rejected field. Its input-contract mismatch was independently reproduced and the renderer preflight fixes that demonstrated mechanism. This does not prove the historical request failed for the same field.

## Verification

The combined affected run passed **143 tests**. Seven Postgres-backed learning tests were skipped because that run did not set GANTRY_DATABASE_URL. Runtime build and TypeScript compilation passed. Private diagnostic tests passed. Whitespace checks passed.

Focused checks cover catalog compatibility, configured summary routes, scoped learning admission, source counting, gateway-bound memory, tool budgets, signed document authority, renderer preflight, actual PDF/DOCX subprocesses, strict structured output, initial provider choice and host capacity. Runtime build includes SDK/contracts, core, migrations and renderer fonts. Final counts are recorded in the coordinated deployment handoff.

Early failures were test setup issues: the fresh worktree had no built renderer, and the structured-capture suite imports require `GANTRY_IPC_DIR`. Both are rerun after building with an isolated temporary IPC path. Skipped environment-dependent tests are not acceptance passes.

## Deployment boundaries

No schema or SDK contract change is introduced here. Existing repository migrations must still run normally. SDK remains `0.9.1`; contracts remain `4.3.0`. The paired Agent.Tender patch contains its own new version and packaged instructions.

Select the chat and research models through Gantry application settings and credentials. Local acceptance selects Luna. Production selects Claude Haiku 4.5. Do not ship rehearsal flags. Load settings before admitting new requests. Recreate the process when applying environment or catalog configuration so existing in-process configuration cannot remain stale. No application rebuild is needed for a supported model setting change.

Keep sandbox restrictions, private token authority, document download authorization and proxy routes intact. Rollback uses the prior image and settings snapshot. No new migration rollback is required for this patch.

Full pre-commit checks were intentionally skipped. Previously waived architecture/autoreview helper gates are not recorded as passed. Paid Luna/Claude and live concurrency/browser acceptance are outside this local verification unless separately recorded by the coordinator.

## Durable model selection

Admission now saves a server-created model snapshot in the existing private pending-interaction JSON. Public requests and their replay hashes remain unchanged. A replay returns its original receipt before resolving any current alias. New attempts use the current settings. Queued and active native answers use the original provider, model and capabilities for execution, summaries, source token counts and learning validation. Credential authorization is still checked for the current application. Credential rotation is permitted. Revocation fails without a provider fallback.

Existing accepted attempts without a snapshot cannot reconstruct their historical model. They fail clearly with “Source answer model snapshot unavailable; start a new attempt”. Operators should allow in-flight old-version work to finish before replacing the image, or ask those callers to start a new attempt. No public API, table or migration is added.

A deterministic test changed and removed the configured alias after admission. It verified both Anthropic-to-OpenAI and OpenAI-to-Anthropic changes without making provider calls. A fresh local PostgreSQL test verified durable storage, repository restart, replay after alias removal and explicit legacy failure. Historical claims that alias override alone pinned active work were incorrect; this snapshot is the repair.

The broader spawn regression run found two existing failures. Both also fail unchanged on baseline `bbba9c315`: the recipe async-tool visibility expectation and the worker response-schema rejection timeout. These are recorded as unresolved test failures, not new snapshot regressions. The snapshot-focused tests, summary/learning/counter checks and real PostgreSQL persistence tests pass.
