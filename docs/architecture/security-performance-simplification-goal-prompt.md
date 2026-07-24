# Security / Performance / Simplification audit — goal prompt

Design of record for the audit-paydown lanes (SEC-1 / PERF-1 / SIMP-1).
Promoted verbatim from the external audit report delivered 2026-07-24.
Audit target: `main` @ `ddfe0d614880fde85ecfdcd478c4460461a01119` (2026-07-22).
NB: findings must be re-verified against current HEAD before implementation —
PAY-1 (architecture gate paydown) shipped after the audit target commit, so the
architecture-checker and decision-parser findings may be partially stale.

---

## Executive summary

Audit target: tracked `main` at commit `ddfe0d614880fde85ecfdcd478c4460461a01119`, committed July 22, 2026. The tracked tree was clean. The audit followed the mandated repository orientation, including `AGENTS.md`, `WORKFLOW.md`, factory and quality documentation, `harness.yaml`, the constitution, product brief, relevant architecture documents, and `./forge decision list --active`.

Overall risk assessment: High. The runtime has strong controls in several important areas—API-key scoping, signed ingress, durable claim fencing, SSRF protection, and outbound workspace-file containment—but those controls are undermined by three high-impact boundary weaknesses:

1. Pull-request code executes on a persistent self-hosted CI runner.
2. Inbound Telegram and Slack attachment writers can cross the workspace boundary through symlinks or a check/open race.
3. The direct LLM endpoint admits large, long-lived requests without a concurrency limit.

The principal scalability risks are synchronous replay-marker scans on every IPC request, an N+1 query pattern on job listing, unbounded durable live-admission history, and process-local limits in a horizontally scalable control plane.

### Five highest-priority findings

1. Critical — Public pull-request code executes on a persistent self-hosted runner with Docker and passwordless-style `sudo` usage.
2. High — Telegram and Slack attachment downloads can overwrite service-account-writable files outside the workspace.
3. High — LLM passthrough has no concurrency admission and makes multiple body-sized copies of requests up to 16 MiB.
4. High — Every signed IPC request synchronously lists and parses every replay marker.
5. High — `GET /v1/jobs` performs one latest-run query per returned job, up to 500 concurrent queries.

### Three strongest simplification opportunities

1. Require durable coordination methods and delete process-local fallbacks. Async-task admission and session compaction currently change semantics based on optional repository capabilities.
2. Establish one canonical source for runtime queue defaults. The same defaults are independently encoded in the settings defaults, settings parser, and queue policy.
3. Collapse the public LLM route and loopback model gateway into one in-process application boundary. The current design serializes and buffers the same request through two HTTP layers in one process.

### Areas inspected

* Runtime entry point, composition root, process roles, fleet capability split, shutdown and startup ownership.
* Control API authentication, scope checks, sessions, jobs, LLM routes, SSE streams, waits, ingress, webhooks, settings, and control-plane state.
* Telegram and Slack channel attachment paths, workspace resolution, sandbox write capabilities, and outbound attachment handling.
* Model credential brokerage, model gateway, provider request forwarding, timeouts, rate limits, and body handling.
* Remote MCP networking, DNS pinning, webhook delivery, egress and SSRF boundaries.
* Postgres schemas and repositories for messages, live admissions, live turns, jobs, runs, async tasks, sessions, events, and leases.
* Queue limits, durable claims, retries, deferrals, replay handling, concurrency and fencing.
* Signed IPC validation and replay persistence.
* Runtime settings parsing, defaults, rendering, and queue policy ownership.
* CI, architecture fitness checks, decision tooling, and representative tests.
* Approximately 1,265 TypeScript production files and 594 test files were mapped; high-risk paths were inspected more deeply than low-risk presentation and formatting code.

### Areas not inspected or insufficiently verified

* The full npm test, typecheck, build, lint, and Postgres integration suites were not run. The repository requires Node `>=24 <26` at `package.json:134-135`; the audit environment had Node 22 and no installed dependencies. I do not represent the current test suite as passing.
* The Python architecture checker was runnable. It was executed against a clean `git archive` of HEAD and failed.
* Database findings were traced to generated SQL paths and indexes, but not measured with production-scale `EXPLAIN ANALYZE`, connection-pool telemetry, or load tests.
* Deployed runner configuration, GitHub organization policy, database retention policy, network topology, and secret-manager permissions were not available in the repository.
* Live provider behavior and real-model failure modes were not exercised.
* Dependency vulnerabilities were not accepted or rejected because an installed dependency tree and verified advisory run were unavailable.
* Untracked `.gstack/` runtime data, the untracked standalone HTML plan, the untracked identity plan, and the untracked `knacklabs-web/` directory were not treated as deployable repository source.
* This was a risk-directed audit, not an exhaustive line-by-line review of all 268,471 production source lines.

## Confirmed findings

### [Critical] Pull-request code executes on a persistent self-hosted CI runner

* Lens: Security
* Confidence: High
* Location: `.github/workflows/ci.yml:3-5`, `:20`, `:37-42`, `:62-66`, `:80-109`, `:116-130`; `package.json:44-79`
* Execution path: Pull request → checkout pull-request-controlled files → `npm ci` and lifecycle scripts → repository-defined build and test commands → Docker Compose build → later `sudo` operations and real-model step.
* Evidence: The workflow runs on `self-hosted`, checks out pull-request content, runs `npm ci`, builds repository Dockerfiles, and executes repository-defined test commands. The same job later invokes `sudo apt-get`, `sudo sysctl`, and a step receiving `E2E_ANTHROPIC_API_KEY`. The repository is public. GitHub explicitly states that self-hosted runners can be persistently compromised by untrusted workflow code and should almost never be used for public repositories.
* Failure or abuse scenario: An attacker submits a pull request whose `package.json`, tests, build scripts, or Docker build context installs a persistent process, modifies runner tooling, replaces a binary earlier on `PATH`, or accesses a privileged Docker daemon. For a fork pull request, the model secret may be empty during that run, but the attacker can persist until a later trusted workflow. For a same-repository pull request or compromised contributor account, sensitive material may be exposed in the same run.
* Impact: Persistent CI host compromise, theft of future repository tokens or model credentials, tampering with builds and artifacts, lateral movement to other repositories sharing the runner, and potentially root-equivalent host access through Docker or the available `sudo` configuration.
* Why existing checks do not prevent it: Empty secrets on fork pull requests limit direct secret injection but do not isolate or destroy the host. Workflow approval also does not make pull-request code trustworthy. There is no ephemeral runner boundary or separate trusted workflow before the secret-bearing step.
* Minimal fix: Run `pull_request` validation on GitHub-hosted runners or truly one-job ephemeral self-hosted runners that are destroyed after execution. Move real-model verification into a separate workflow triggered only from a reviewed, trusted commit or protected environment. Do not expose a persistent host Docker daemon to untrusted pull-request code. Explicitly minimize `GITHUB_TOKEN` permissions.
* Verification: Use an authorized canary pull request that attempts to persist a unique marker, background process, modified executable, and Docker object. Confirm that neither a subsequent trusted job nor any other repository can observe them. Confirm that the secret-bearing workflow checks out only the trusted SHA and cannot be triggered with pull-request-controlled code.
* Scope: Immediate blocker

### [High] Inbound channel attachments can overwrite files outside the workspace

* Lens: Security
* Confidence: High
* Location:
  * Telegram: `apps/core/src/channels/telegram/media-ingestion.ts:253-266`, `apps/core/src/channels/telegram/channel-prompts.ts:592-637`, `apps/core/src/channels/telegram-file-download.ts:37-57`
  * Slack: `apps/core/src/channels/slack/channel-state.ts:525-580`, `apps/core/src/channels/slack/attachment-download.ts:28-43`
  * Shared writer: `apps/core/src/shared/private-fs.ts:16-44`
  * Workspace write capability: `apps/core/src/runtime/agent-spawn-helpers.ts:365-394`
  * Hardened sibling implementation: `apps/core/src/platform/workspace-message-attachment.ts:34-176`
* Execution path: Channel participant supplies document filename → filename is sanitized but remains deterministic → destination becomes `<workspace>/attachments/<filename>` → host Gantry process opens destination with `writeFile` or `'w'`.
* Evidence: Telegram performs no final-target symlink check before `fs.promises.writeFile` or `fs.promises.open(destPath, 'w', ...)`. Slack calls `lstat` and then separately calls `writeFileSync` or `openSync(..., 'w')`, leaving a check-to-open race. The agent sandbox has `workspace_write` access, so an agent, prompt-injected tool invocation, checked-out repository, or another workspace writer can create the final symlink. A disposable filesystem reproduction confirmed that Node's `'w'` open follows an existing symlink and truncates its target. The repository already contains a hardened descriptor-based pattern for outbound attachments.
* Failure or abuse scenario: A malicious workspace creates `attachments/report.pdf` as a symlink to a service-account-writable file outside the workspace. A participant then uploads `report.pdf`. Telegram deterministically follows the link. For Slack, an attacker can either exploit the buffered helper's check/write race or replace the target between `lstatSync` and `openSync`.
* Impact: Overwrite or truncation of runtime settings, token files, scripts, caches, or other files writable by the Gantry service account. Depending on deployment layout, this can cause denial of service, credential replacement, policy alteration, or code execution on restart.
* Why existing checks do not prevent it: Filename sanitization blocks traversal strings but does not resolve filesystem links. `ensurePrivateDirSync` validates the attachment directory, not the final file. Slack's `lstat` is non-atomic with the subsequent open. File mode `0600` does not stop symlink following.
* Minimal fix: Create a collision-resistant temporary file inside a verified attachment directory using `O_CREAT | O_EXCL | O_NOFOLLOW`; validate the opened descriptor and containment; stream into that descriptor; then atomically publish the final name without replacing an existing target. Alternatively, always use generated immutable storage names and keep the original filename only as metadata. Apply one shared hardened writer to every inbound channel.
* Verification: Add real-filesystem tests for an existing final-file symlink, final-file swap during open, ancestor-directory swap, hard links where supported, and both streaming and buffered response paths. Assert that the outside target remains unchanged and that cleanup cannot unlink or truncate it.
* Scope: Immediate blocker

### [High] The LLM passthrough has no concurrency admission and repeatedly buffers large bodies

* Lens: Security
* Confidence: High
* Location:
  * Public route: `apps/core/src/control/server/routes/llm.ts:27-28`, `:70-84`, `:108-147`, `:203-251`
  * Public body reader: `apps/core/src/control/server/http.ts:48-81`
  * Internal gateway: `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:64-69`, `:88-106`, `:416-480`
  * Internal body reader: `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-http.ts:241-264`
  * Gateway limiter: `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-rate-limit.ts:1-55`
* Execution path: Authenticated `/llm/v1/*` request → public body reader buffers up to 16 MiB → UTF-8 conversion and JSON parse → model field mutation → full JSON reserialization → loopback HTTP fetch → model gateway buffers the request again → provider fetch may remain occupied for ten minutes.
* Evidence: The public route has a 120-requests-per-minute per-key rate limit but no global, per-app, or per-key semaphore. `readRawBody` retains chunks and then allocates `Buffer.concat`; parsing creates a string and object graph; serialization allocates another body buffer. The loopback model gateway then uses another chunk array and `Buffer.concat`. Its default upstream timeout is ten minutes.
* Failure or abuse scenario: A compromised or intentionally abusive key with `llm:invoke` scope opens 120 near-16-MiB requests in a burst while the provider responds slowly. Every request passes the minute-based counter, retains several body-sized allocations, and can occupy sockets and permits for up to ten minutes.
* Impact: Process memory exhaustion, excessive garbage collection, control-plane latency, open-socket exhaustion, and loss of availability for unrelated control traffic. The same pattern can amplify provider cost and connection pressure.
* Why existing checks do not prevent it: The 16-MiB body limit bounds one request, not aggregate memory. A requests-per-minute counter does not constrain simultaneous occupancy. `maxTokens` limits generated tokens, not input size or concurrent requests. The ten-minute timeout bounds eventual duration but leaves a very large resource window.
* Minimal fix: Acquire a race-free global and per-app/key concurrency permit before reading the request body. Reject excess requests before consuming their bodies and release permits in a single `finally` path covering disconnects, parse failures, setup failures, and provider failures. Reduce the body limit unless 16 MiB is demonstrated as necessary. A later simplification should remove the loopback serialization boundary.
* Verification: Hold upstream responses behind a test barrier, submit more requests than the configured limit, and prove that only the allowed number begin body consumption. Measure resident memory and open sockets with concurrent maximum-sized requests. Exercise client disconnect, malformed JSON, credential failure, upstream timeout, and streamed response cleanup.
* Scope: Immediate blocker

### [High] IPC replay cleanup performs synchronous full-directory scans on every request

* Lens: Performance
* Confidence: High
* Location: `apps/core/src/runtime/ipc-auth-validation.ts:45-54`, `:206-229`, `:231-264`, `:286-327`; `apps/core/src/infrastructure/ipc/request-signing.ts:5`, `:29-60`
* Execution path: Signed IPC request → signature and freshness validation → `reserveFreshIpcRequestId` → `pruneConsumedIpcRequestIds` → synchronous `readdirSync` → synchronous read and JSON parse of every replay-marker file → creation of the new marker.
* Evidence: `pruneConsumedIpcRequestIds` runs before every replay reservation. It scans the in-memory map and then synchronously lists, reads, parses, and possibly removes every `.json` marker in `DATA_DIR/ipc-replay`. Markers are valid for up to five minutes.
* Failure or abuse scenario: At ten signed IPC actions per second, approximately 3,000 markers can be live within the five-minute window. Each new request then reads and parses roughly 3,000 files, creating about 30,000 synchronous file reads per second. A multi-agent worker using browser, memory, task, message, and permission IPC can reach this workload without malicious traffic.
* Impact: Event-loop starvation, increased turn latency, delayed heartbeats and claim renewal, and cascading worker instability. Complexity grows approximately with the square of the request rate over the retention window.
* Why existing checks do not prevent it: The five-minute expiry bounds the directory eventually but does not bound work per request. Atomic `wx` marker creation correctly prevents replay but is unrelated to cleanup cost. Current tests verify replay correctness and restart durability, not scale.
* Minimal fix: Remove cleanup from the request admission path. Use periodic or amortized bounded cleanup, expiry-bucketed directories, or a durable uniqueness store with TTL. Preserve atomic create-if-absent behavior, but perform at most a constant or tightly bounded amount of cleanup per request. Avoid synchronous directory-wide I/O on the Node event loop.
* Verification: Prepopulate 5,000 and 20,000 valid markers and assert that one validation performs a bounded number of filesystem operations with stable latency. Retain tests for concurrent duplicate reservation and replay rejection after process restart.
* Scope: Bounded follow-up

### [High] Listing jobs produces up to 500 concurrent latest-run queries

* Lens: Performance
* Confidence: High
* Location: `apps/core/src/control/server/routes/jobs.ts:394-426`; `apps/core/src/application/jobs/job-management-service.ts:66-67`, `:265-297`; `apps/core/src/application/jobs/job-visibility-metadata.ts:203-225`, `:294-308`; `apps/core/src/adapters/storage/postgres/repositories/canonical-job-repository.postgres.ts:587-619`; `apps/core/src/adapters/storage/postgres/schema/runs.ts:82-94`
* Execution path: `GET /v1/jobs` → list up to 100 jobs by default or 500 by request → `buildJobListVisibilityMetadata` → `Promise.all` over jobs → one `listJobRuns(job.id, 1)` query for every job.
* Evidence: `loadLatestRunsByJobId` explicitly maps every job to an independent repository call. The default list size is 100 and the maximum is 500. `Promise.all` launches the calls together rather than applying backpressure.
* Failure or abuse scenario: A normal administrative request for 500 jobs creates approximately one job-list query plus 500 latest-run queries. Concurrent dashboards, SDK polling, or multiple control replicas multiply the burst against the database and connection pool.
* Impact: Pool saturation, high query scheduling overhead, elevated database CPU, tail-latency spikes, and interference with claim, heartbeat, message, and control-plane transactions.
* Why existing checks do not prevent it: `idx_agent_runs_job_started` is appropriate for each individual lookup, so each query may be fast, but it does not remove the network round trips, query planning, pool acquisition, or 500-way burst. Promise deduplication exists for inherited tool bindings, not for run loading.
* Minimal fix: Add one batch repository method that returns the latest run for all requested job IDs using `DISTINCT ON (job_id)` or a window function. Until that lands, apply a small concurrency limit rather than launching 500 queries simultaneously.
* Verification: Instrument SQL query count for a 500-job request and require a constant, small number of queries. Load-test concurrent list requests while monitoring pool wait time, database CPU, and p95/p99 latency.
* Scope: Bounded follow-up

### [Medium] Durable live-admission work has neither an admission quota nor terminal retention

* Lens: Performance
* Confidence: High
* Location: `apps/core/src/domain/ports/live-turns.ts:125-153`; `apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:440-478`; `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts:51-117`, `:287-318`; `apps/core/src/adapters/storage/postgres/schema/live-turns.ts:134-209`; `apps/core/src/config/settings/runtime-settings-defaults.ts:164-173`; `apps/core/src/runtime/group-queue-policy.ts:1-46`
* Execution path: Eligible inbound message → canonical-message transaction → unconditional live-admission insert unless an identical idempotency record exists → worker claim/defer/retry → terminal state update with `endedAt` → row remains indefinitely.
* Evidence: Enqueue has no per-app, per-conversation, or total active-row count. The schema has indexes for queued, deferred, and expired claimed rows but no terminal-retention index. Settlement updates state and timestamps but never deletes or compacts the record. Repository-wide searches found no purge path. The default process-local message and task backlog values are `0`, which means unlimited.
* Failure or abuse scenario: A malfunctioning integration, inbound event storm, or malicious channel participant produces unique messages faster than live workers can process them. Every message creates a durable row. Even after recovery, terminal rows containing conversation, sender ID, sender display name, and trigger metadata continue to accumulate.
* Impact: Unbounded active backlog, continuously growing indexes and backups, slower maintenance and migration operations, and indefinite retention of identity metadata. A sustained overload can turn a temporary traffic spike into persistent database pressure.
* Why existing checks do not prevent it: Idempotency suppresses exact replay only. Claim limits control worker throughput, not insertion. Local queue limits do not bound the durable admission table, and their defaults are unlimited in any case.
* Minimal fix: Add atomic per-app and optionally per-conversation admission limits at the transaction that inserts the work item. Return an explicit overloaded or deferred outcome instead of silently accumulating. Define terminal retention, add an `ended_at`-based index, and run a bounded purge or archival job. Keep canonical messages independently if they are required as the durable conversation record.
* Verification: Flood beyond the configured admission cap and prove active rows remain bounded under concurrent writers. Verify that exact replay still returns the existing item. Run retention against mixed active and terminal records and prove that no active, deferred, or recently completed item is removed.
* Scope: Architecture decision required

### [Medium] Rate limits are process-local despite supported horizontal control scaling

* Lens: Security
* Confidence: High
* Location: `apps/core/src/control/server/rate-limit.ts:3-34`; `apps/core/src/control/server/index.ts:312-348`; `apps/core/src/control/server/routes/llm.ts:72-79`; `apps/core/src/control/server/routes/jobs.ts:618-622`; `apps/core/src/control/server/external-ingress-adapter.ts:202`; `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-rate-limit.ts:1-55`; `docs/architecture/deployment-profiles.md:262-277`
* Execution path: Request reaches one control or model-gateway process → that process consults its private in-memory `Map` → another replica has an independent map and counter.
* Evidence: The control limiter is instantiated once per control server. The gateway implementation explicitly documents that it is in-memory and non-persistent. Deployment documentation supports horizontal control scaling.
* Failure or abuse scenario: With three control replicas, the effective advertised limit can become approximately three times the configured value because requests distributed across replicas receive independent budgets. Restarting a process resets its budget. This affects LLM invocation, job triggering, and external ingress controls.
* Impact: Resource-limit bypass, unexpected provider spend, larger job and ingress bursts, and configuration behavior that changes with replica count rather than the declared policy.
* Why existing checks do not prevent it: Load balancing does not provide sticky, authoritative accounting. Per-process maps cannot observe admissions on sibling replicas. The settings surface does not clearly state that limits are multiplied by process count.
* Minimal fix: Either enforce the counters through one shared atomic store, such as Postgres or Redis, or explicitly make the relevant service singleton and reject a horizontally scaled configuration. Document whether each limit is per-process or cluster-wide.
* Verification: Send requests through two live control replicas and require the combined accepted count to equal the configured cluster limit. Restart one replica and verify that doing so does not replenish the shared budget.
* Scope: Architecture decision required

### [Medium] The SSE stream limit is raceable during subscription setup

* Lens: Performance
* Confidence: High
* Location: `apps/core/src/control/server/routes/sessions.ts:371-430`; `apps/core/src/application/sessions/session-interaction-module.ts:411-419`; `apps/core/src/control/server/index.ts:312-348`
* Execution path: Session event-stream request → check `activeStreams < 25` → await session lookup and event subscription → increment `activeStreams`.
* Evidence: The limit is checked at `sessions.ts:389`, but the counter is not incremented until `:429`, after the asynchronous subscription setup. The sibling wait route reserves its counter before awaiting at `sessions.ts:468-496`.
* Failure or abuse scenario: Twenty-six or more simultaneous requests reach the check while `activeStreams` is zero. All pass, all wait for subscription setup, and all are subsequently admitted, exceeding the intended cap.
* Impact: Unbounded-by-policy event subscriptions, open sockets, notification listeners, and database/event-exchange work. Repeated bursts can exhaust connection and listener resources.
* Why existing checks do not prevent it: JavaScript's single-threaded execution does not make a check followed by an `await` atomic. No permit is reserved before control yields.
* Minimal fix: Increment or reserve a token synchronously immediately after the limit check, before the first `await`. Release it in a single idempotent cleanup path on setup failure, disconnect, subscription close, or normal termination.
* Verification: Block subscription setup behind a barrier, issue 26 concurrent requests, and prove exactly 25 are admitted and the remainder receive `429 TOO_MANY_STREAMS`. Exercise setup rejection and early disconnect to ensure permits are returned once.
* Scope: Bounded follow-up

### [Medium] The architecture fitness checker is red on main and absent from CI

* Lens: Testing
* Confidence: High
* Location: `package.json:60`; `docs/architecture/current-verification-commands.md:143-164`; `.github/workflows/ci.yml:50-109`
* Execution path: Pull request → CI runs supply-chain checks, format, typecheck, build, and tests → no architecture command runs → local or release process may optionally invoke an already-failing checker.
* Evidence: `npm run check:architecture` is documented as a ratchet and release gate. It is absent from the CI workflow. Running the checker against a clean archive of current HEAD exited with status 1 and reported 108 entries: 19 file-size budget failures, eight layer-import failures, two provider-boundary failures, 16 provider-specific-path failures, and 63 stale active-document references.
* Failure or abuse scenario: A pull request introduces another forbidden import or provider leak. CI remains green because the checker is not invoked. A developer who runs it locally receives a large pre-existing failure set, making it difficult to distinguish the new violation from existing debt.
* Impact: Documented architecture boundaries are advisory rather than enforceable. Layer drift, provider coupling, oversized modules, and stale architecture references can accumulate despite the repository claiming a ratcheted gate.
* Why existing checks do not prevent it: Typechecking and tests do not encode the checker's import, provider, size, or documentation rules. A permanently red optional check cannot reliably function as a regression ratchet.
* Minimal fix: Triage the 108 entries into real violations, stale documentation, and checker false positives. Restore a passing baseline without broadly raising every allowance, then add the command as a required CI step. Baseline any intentionally accepted debt with exact path/count entries rather than disabling categories.
* Verification: Require a clean HEAD to pass. Add a fixture or controlled mutation for each rule class and prove CI fails on one additional violation. Confirm that expired or over-budget exceptions fail.
* Scope: Bounded follow-up
* _Harness note 2026-07-24: PAY-1 (architecture gate paydown, `check:architecture` exit 0) shipped after the audit target commit — re-verify what remains of this finding before scheduling._

### [Medium] The active-decision command silently hides accepted decisions

* Lens: Quality
* Confidence: High
* Location: `AGENTS.md:17-27`; `WORKFLOW.md:68-75`; `.agents/scripts/forge_cli/decisions.py:72-98`; `docs/decisions/2026-06-14-agent-harness-selection.md:1-8`; `docs/decisions/2026-04-27-claude-runtime-materialization.md:1-5`
* Execution path: Engineer follows mandatory read order → runs `./forge decision list --active` → command scans decisions → defaults each record to `proposed` unless it contains exact lowercase `status:` metadata → records are omitted from the active view.
* Evidence: The parser uses the case-sensitive expression `status:\s*(\S+)`. Existing decisions express acceptance as `> **Status: accepted ...**` or as a Markdown `## Status` section containing `Accepted.`. Running the mandated command from the repository root exited successfully and printed no active decisions.
* Failure or abuse scenario: An engineer or automation agent follows the documented process and concludes there are no binding decisions. It then changes provider selection, runtime materialization, storage ownership, or another governed area in conflict with a decision that the document itself labels accepted.
* Impact: Architectural inconsistency, repeated debate, conflicting implementations, and false confidence that the required orientation process was completed.
* Why existing checks do not prevent it: Unrecognized status text silently becomes `proposed`; the command emits no warning about status-like content it could not parse. Exit status remains zero.
* Minimal fix: Standardize decision metadata in machine-readable frontmatter and migrate the corpus. During migration, accept the existing documented formats or fail loudly when a record contains an unparseable status section. Do not silently default a status-like document to proposed.
* Verification: Add fixtures for proposed, accepted, superseded, both legacy accepted syntaxes, malformed status, and missing status. Assert that accepted records appear under `--active`, superseded records do not, and malformed records make the command fail.
* Scope: Bounded follow-up

## Simplification and refactoring opportunities

### 1. Require durable coordination methods and remove local semantic fallbacks

* Current design: `AsyncTaskRepository` makes atomic admission and claim methods optional at `apps/core/src/domain/ports/async-tasks.ts:176-184`. `createAdmittedAsyncTask` falls back to a separate count-then-create sequence at `apps/core/src/jobs/async-task-admission.ts:17-50`. Session compaction uses durable scoped admission only when the optional repository method is present and otherwise falls back to a process-global `Set` at `apps/core/src/session/session-compaction-command.ts:27`, `:57-80` and `apps/core/src/runtime/group-session-command-state.ts:176-214`.
* What is currently difficult: Callers cannot determine from their type whether backlog and deduplication guarantees are atomic, durable, restart-safe, or process-local. The same application service has different concurrency semantics depending on wiring.
* Unnecessary complexity or poor ownership: Optional capability probing, the local count/create fallback, the global `queuedCompactions` set, and branches for durable versus non-durable behavior all encode two coordination systems.
* Proposed simpler design: Make the existing atomic admission and claim methods required for production repositories. Have the in-memory test repository implement the same atomic semantics directly rather than making the application service detect capabilities.
* Code or concepts that could be removed: `createTaskWithLocalAdmission`, optional-method checks around scoped admission, the process-global compaction deduplication fallback, and several `undefined` outcome branches.
* Behavior that must remain unchanged: Per-app and per-agent backlog caps, compaction deduplication, stale-task recovery, fencing, user-visible "already running" responses, and restart-safe task records.
* Estimated scope: Medium; repository interfaces, in-memory test repositories, composition wiring, and compaction tests.
* Risks: Test fixtures or workstation-only paths may currently depend on partial repositories. Making capabilities mandatory will expose those incomplete implementations.
* Verification strategy: Run concurrent admission tests against both Postgres and the in-memory implementation, including two workers, process restart simulation, stale running tasks, and exact cap boundaries.
* Timing: Separate bounded refactor after the immediate security blockers.

### 2. Establish one canonical source for runtime queue defaults

* Current design: Queue defaults are independently encoded in:
  * `apps/core/src/config/settings/runtime-settings-defaults.ts:164-173`
  * `apps/core/src/config/settings/runtime-settings-parser.ts:596-615`
  * `apps/core/src/runtime/group-queue-policy.ts:1-46`
* What is currently difficult: Changing a default requires coordinated edits across configuration generation, parsing, runtime normalization, documentation, and tests. A missed edit creates environment-dependent behavior.
* Unnecessary complexity or poor ownership: The parser constructs a second full default object, while the queue layer independently owns another set of fallback constants.
* Proposed simpler design: Export one immutable `RuntimeQueueSettings` default value from the existing settings-defaults boundary. Parse by overlaying validated input onto that value. Pass fully resolved queue settings into `GroupQueue`; retain optional constructor fields only in test helpers if needed.
* Code or concepts that could be removed: The duplicate object at `runtime-settings-parser.ts:597-615`, queue-policy literal constants, and tests that separately assert identical constants at multiple layers.
* Behavior that must remain unchanged: Current values, `0` meaning unlimited backlog, validation ranges, host-capacity clamping, YAML rendering, and workstation defaults.
* Estimated scope: Small to medium.
* Risks: Introducing a config/runtime circular dependency if the default is placed in the wrong module.
* Verification strategy: Assert `parseSettings({})` equals the canonical defaults, round-trip defaults through the renderer and parser, and retain boundary tests for zero, negative, and oversized values.
* Timing: Do now as a small simplification after blocker fixes.

### 3. Collapse the public LLM route and loopback model gateway into one application service

* Current design: The public route authenticates, parses, mutates, and serializes the body before calling an HTTP server hosted by `GantryModelGatewayBroker`. That server authenticates another token, parses the HTTP request again, injects provider credentials, and calls the upstream provider.
* What is currently difficult: Cancellation, logging, token revocation, rate limits, timeouts, header policy, and body limits are split across two HTTP boundaries. Diagnosing one request requires tracing both.
* Unnecessary complexity or poor ownership: The loopback HTTP hop exists inside the same process for the direct API path. It duplicates request readers, header transformations, authentication, error mapping, and resource accounting.
* Proposed simpler design: Extract the existing provider-forwarding behavior into one in-process application operation used directly by the public route. Keep the loopback HTTP adapter only for child runners that genuinely require an HTTP endpoint.
* Code or concepts that could be removed: One body reader on the public path, one serialization/deserialization cycle, loopback header copying for direct calls, and some gateway-token issuance/revocation for control-API invocations.
* Behavior that must remain unchanged: Provider credential isolation, per-app and per-route audit records, provider path confinement, request validation, streaming semantics, cancellation, rate limits, and child-runner gateway support.
* Estimated scope: Medium to large.
* Risks: Audit ordering, streaming response behavior, and credential lifetime could subtly change.
* Verification strategy: Contract-test the current and simplified paths with identical inputs and assert equivalent provider URL, headers, body, streaming frames, usage records, errors, cancellation, and revocation.
* Timing: Separate architecture plan after concurrency admission is fixed.

### 4. Replace per-job visibility lookups with one batch projection

* Current design: Job visibility metadata loads latest runs through one repository call per job and separately memoizes inherited tools by agent.
* What is currently difficult: The control route assembles a view through a mixture of batch list results, per-job database calls, and per-agent asynchronous lookups.
* Unnecessary complexity or poor ownership: The view builder is responsible for orchestrating database fanout instead of consuming one repository projection suitable for the API.
* Proposed simpler design: Add one repository query returning `{jobId, latestRun}` for all visible job IDs, then build metadata synchronously from two maps.
* Code or concepts that could be removed: `loadLatestRunsByJobId`'s `Promise.all`, hundreds of individual repository calls, and mocks expecting per-job lookup sequencing.
* Behavior that must remain unchanged: Latest-run ordering, health and staleness calculations, error summaries, app filtering, and the public response schema.
* Estimated scope: Small.
* Risks: Incorrect SQL partitioning or treatment of `NULL started_at`.
* Verification strategy: Compare the batch result with the current per-job result across pending, running, completed, failed, and null-start-time runs.
* Timing: Do now as part of the performance fix.

### 5. Construct control application services once instead of per route invocation

* Current design: `createJobManagementService` reads runtime globals and constructs a new service at `apps/core/src/control/server/routes/jobs.ts:145-167`; it is called from ten route branches. `createSessionInteractionModule` does the same at `apps/core/src/control/server/session-interaction-adapter.ts:19-35` and is recreated throughout `apps/core/src/control/server/routes/sessions.ts`.
* What is currently difficult: Dependencies are hidden behind global getters, tests must mock global runtime state, and route handlers repeatedly rebuild identical service graphs.
* Unnecessary complexity or poor ownership: The factories do not create meaningful request-specific state; they mostly rename global singleton access.
* Proposed simpler design: Build the job and session application services once in the control-server composition root and pass them through `ControlRouteContext`.
* Code or concepts that could be removed: Route-local factories, repeated global repository lookups, context-optional branches, and several global-runtime mocks.
* Behavior that must remain unchanged: Live settings getters that intentionally reload, request-specific app identity, current credential broker access, clocks, and event-exchange behavior.
* Estimated scope: Medium.
* Risks: Accidentally snapshotting a dependency that is intended to be read live after settings reload.
* Verification strategy: Classify each dependency as stable or live. Keep live values behind explicit getters, then run route tests before and after settings reload and runtime-store initialization.
* Timing: Separate cleanup after the API behavior fixes.

## Over-engineering inventory

* Optional repository capabilities with fallback semantics: `AsyncTaskRepository` exposes multiple optional atomic methods at `async-tasks.ts:176-184`, forcing capability probing throughout application code. The result is more branching and weaker guarantees rather than useful provider polymorphism.
* Two HTTP layers for one in-process LLM request: `apps/core/src/control/server/routes/llm.ts` and `gantry-model-gateway.ts` both implement request admission, body handling, headers, cancellation, errors, and audit behavior for the same direct API call.
* Two incompatible in-memory rate-limiter implementations: `control/server/rate-limit.ts:11-34` uses fixed windows and scans every bucket on every request; `gantry-model-gateway-rate-limit.ts:17-55` uses timestamp arrays and array filtering. Neither is cluster-authoritative.
* Per-request service construction around global state: `routes/jobs.ts:145-167` and `session-interaction-adapter.ts:19-35` create nominal dependency-injected services but source nearly all dependencies from global runtime getters.
* Three owners for queue defaults: Settings defaults, parser defaults, and runtime queue-policy constants independently encode the same values.
* Two decision-status grammars: Forge writes and parses lowercase frontmatter-like `status:` fields, while the decision corpus uses prose and formatted Markdown. The extra lifecycle tooling currently obscures rather than clarifies the authoritative state.
* Architecture-ratchet machinery without a viable gate: Exception files, provider-boundary budgets, file-size budgets, and active-document checks are maintained, but the checker is red on main and absent from CI. The machinery has ongoing cost without reliably preventing new debt.

## Missing verification

1. CI runner isolation: No automated or operational test proves that pull-request code cannot persist state, access a privileged Docker daemon, or influence a later secret-bearing run.
2. Real-filesystem inbound attachment safety: Telegram tests at `apps/core/test/unit/channels/telegram.test.ts:2741-2829` mock `fs.promises.open`; Slack tests at `apps/core/test/unit/channels/slack.test.ts:2914-2978` mock `lstat`, `open`, and write calls. They do not exercise actual symlink semantics or races.
3. LLM occupancy limits: Existing tests cover forwarding, rate responses, streams, disconnects, and errors, but not simultaneous maximum-size requests held behind a slow upstream.
4. IPC replay scale: `apps/core/test/unit/runtime/ipc-auth-boundary.test.ts:1469-1508` verifies expiry, replay, and restart behavior but does not test thousands of markers or event-loop latency.
5. Job-list query count: No route-level Postgres test asserts a bounded query count for 100 or 500 jobs.
6. Multi-replica rate limits: Current unit tests exercise a single limiter instance. No test starts two control or gateway instances against one configured limit.
7. Concurrent SSE admission: The suite contains a normal event-stream test, but no barrier-based test for 26 simultaneous stream setup attempts.
8. Durable live-admission overload: There is no test establishing an admission cap, overload response, bounded active row count, or terminal retention policy.
9. Architecture CI: The architecture checker is not run by `.github/workflows/ci.yml`, and clean HEAD does not pass it.
10. Decision corpus parsing: No regression test appears to parse the actual status formats already present under `docs/decisions/`.
11. Production-like load verification: There is no demonstrated benchmark covering control-plane body memory, IPC throughput, job-list database fanout, or live-admission table growth.
12. Deployment-policy verification: The repository does not prove that control-plane replica count, runner ephemerality, shared rate-limit storage, and retention jobs match the documented deployment model.

## Rejected hypotheses

* Control API authentication is fail-open: Rejected. `apps/core/src/control/server/auth.ts:21-45` requires a Bearer token, hashes it, uses `timingSafeEqual`, and enforces scopes. Strict production parsing rejects weak tokens, invalid app IDs, duplicate key IDs, invalid scopes, and empty scope sets at `apps/core/src/shared/control-api-keys.ts:116-203`.
* External ingress signatures can be replayed or moved across methods and paths: Rejected. The signature payload binds method, path, timestamp, nonce, body hash, and raw body at `apps/core/src/application/external-ingress/signature.ts:18-100`. Invocation enforces app scope, durable idempotency, and nonce reservation at `external-ingress-module.ts:228-313`.
* External ingress stores raw signed payloads or signatures indefinitely: Rejected for the inspected invocation path. It persists `sha256:<bodyHash>` and the literal value `redacted` for the signature at `external-ingress-module.ts:297-312`.
* Webhook delivery has a straightforward DNS-rebinding SSRF: Rejected. Webhook validation defaults to HTTPS, rejects URL credentials and private addresses, checks all resolved records, and returns a validated address at `apps/core/src/control/server/webhook-target.ts:17-100`. Delivery pins the connection to that address while retaining the original TLS server name at `webhook-delivery.ts:62-97`.
* Remote MCP requests have an equivalent rebinding window: Rejected. Remote MCP uses a DNS-pinned fetch, rejects non-HTTP protocols and private or mixed DNS results, pins the request lookup, preserves TLS SNI, applies a deadline, and can reject redirects at `apps/core/src/application/mcp/mcp-tool-proxy-network.ts:30-52` and `apps/core/src/shared/dns-pinned-fetch.ts:24-75`, `:77-178`.
* Outbound workspace attachments permit path traversal or symlink exfiltration: Rejected. `apps/core/src/platform/workspace-message-attachment.ts:34-176` validates relative paths, canonical containment, descriptor containment, `O_NOFOLLOW`, regular-file status, link count, and size around the opened descriptor.
* The job latest-run query lacks a supporting database index: Rejected. `idx_agent_runs_job_started` covers job ID plus descending start and creation time at `apps/core/src/adapters/storage/postgres/schema/runs.ts:82-86`. The accepted problem is query fanout, not a missing per-query index.
* Live-admission workers can trivially claim the same item concurrently: Rejected. Claim selection uses `FOR UPDATE SKIP LOCKED`, atomically assigns a claim token and worker, increments a fencing version, and subsequent renewal and settlement require the matching token and worker at `live-admission-work-item-repository.postgres.ts:120-225`, `:287-318`.
* The model gateway has no upstream timeout: Rejected. It has a ten-minute default and abort controller at `gantry-model-gateway.ts:64-69`, `:458-480`. The accepted concern is that ten minutes is a long occupancy window without concurrency admission.
* All long-poll admission counters share the SSE race: Rejected. Session waits reserve `activeWaits` before awaiting and release it in `finally` at `sessions.ts:465-497`. The race is specific to SSE subscription setup.

## Recommended execution order

1. Security and correctness blockers
   1. Stop running pull-request-controlled code on the persistent self-hosted runner.
   2. Replace Telegram and Slack inbound file writers with one atomic no-follow implementation and add real-filesystem adversarial tests.
   3. Add race-free concurrency admission before LLM request-body consumption.
   4. Repair the decision parser so mandated orientation exposes the actual accepted corpus.
2. High-value performance fixes
   1. Remove synchronous full-directory IPC replay cleanup from request admission.
   2. Replace the job-list N+1 latest-run lookups with one batch query.
   3. Reserve SSE stream permits before subscription setup.
   4. Introduce measurable live-admission caps and define terminal retention.
3. Small simplifications
   1. Establish canonical runtime queue defaults and remove duplicate literals.
   2. Construct job and session application services once in the control composition root.
   3. Restore a passing architecture-check baseline and make it a required CI gate.
   4. Consolidate tests around production filesystem, concurrency, and SQL paths rather than mocked call sequences.
4. Larger changes requiring a separate plan or architecture decision
   1. Decide whether limits are cluster-wide or whether affected services are intentionally singleton; then implement one authoritative admission store.
   2. Make durable async-task and compaction coordination mandatory and delete process-local fallbacks.
   3. Collapse the direct LLM loopback HTTP hop into an in-process application service while retaining the HTTP gateway for isolated child runners.
   4. Define explicit ownership for live-admission backlog, overload behavior, audit retention, archival, and deletion.

No repository files were modified during the audit.
