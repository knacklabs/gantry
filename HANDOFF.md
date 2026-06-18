# HANDOFF — provider-derived engine + OpenRouter caching (2026-06-13)

> Branch: `feature/deepagents-agent-engine`. This section is additive; the
> agent-engine and deployment-modes handoffs below are unchanged (kept as
> history — the user-selectable engine they describe is now superseded).
>
> **What shipped (4 commits on `71f23b6f..HEAD`).** The engine is now **derived
> from the model's provider, not chosen.** The user picks the model
> (alias -> provider -> engine); Claude (`anthropic`) -> `anthropic_sdk` (the only
> Claude OAuth/subscription lane, also API-key); OpenAI/OpenRouter/future ->
> `deepagents`. Engine is a read-only derived diagnostic.
>
> - `9b4f781b` — derive-engine refactor. Single derivation point
>   `deriveAgentEngineForProvider`; `resolveExecutionRoute(entry)` takes no
>   `agentEngine` input; the engine x provider incompatibility branch + locked
>   copies removed. Clean-cut removal of the `agent_engine` + `memory.engine`
>   settings (parse/render/import/export/validate/project), the `gantry agent
>   engine` CLI verb, the `PATCH /v1/agents/:id` `agentEngine` write, the
>   `AGENT_ENGINE_CHANGED` + `MEMORY_ENGINE_CHANGED` audit events,
>   `memory-engine-matrix`, and the now-dead `anthropic-memory-direct` memory
>   client. Memory router dispatches purely on the memory model's response family
>   (anthropic -> Claude SDK; openai/openrouter -> OpenAI-compatible). Derived
>   engine still shown in agent read responses, `model why`/list/show, model
>   preview, and resolved-run audit. (Also folds in the in-progress
>   startup-timing + pre-spawn admission instrumentation.)
> - `cbd4729d` — library-driven model construction + OpenRouter DeepAgents lane.
>   Runner builds models via `initChatModel("openai:<id>", ...)` and
>   `@langchain/openrouter` `ChatOpenRouter` (no env-sniffing factory); host
>   projects `GANTRY_DEEPAGENTS_MODEL_PROVIDER`. OpenRouter is the
>   DeepAgents/OpenAI-compatible lane end to end (gateway projects
>   `OPENAI_BASE_URL`/`OPENAI_API_KEY`, allows `/v1/chat/completions`, bearer;
>   `ChatOpenRouter` -> `openrouter.ai/api/v1/chat/completions`). OpenRouter
>   `cacheSupport` corrected to automatic provider-prefix caching; OpenRouter
>   memory routes through the OpenAI-compatible client. Adds `@langchain/openrouter`.
> - `0465f244` — DeepAgents runner prompt-cache accounting + sticky routing +
>   gated breakpoints. Stream-normalizer reads
>   `prompt_tokens_details.cached_tokens`/`cache_write_tokens` (fixes the OpenAI
>   gpt lane too); `ChatOpenRouter` gets a stable `session_id`; host projects
>   `GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL` and the runner injects ephemeral
>   `cache_control` only for explicit-cache providers (automatic providers — Kimi,
>   OpenAI — inject nothing).
> - (Packet 7, this session) — docs + cleanup: README, ADR
>   `2026-06-12-agent-engine-selection.md` (superseding section), credential-
>   management, root + docs AGENTS model vocabulary, adapter AGENTS, this handoff,
>   and the handoff-plan status note.
>
> **Decision:** `docs/decisions/2026-06-12-agent-engine-selection.md` —
> "Superseding decision (2026-06-13): provider-derived engine + OpenRouter caching".
>
> **Known library limitation:** `@langchain/openrouter` 0.3.0 surfaces cache
> *reads* but not *writes* on streamed chunks (normalizer captures writes if a
> later version exposes them).
>
> **Remaining (by design):** explicit `cache_control` breakpoints are wired but no
> shipped model needs them today (no Anthropic/Gemini/Qwen sub-models on the
> OpenRouter lane); DeepAgents shell/filesystem authority stays disabled.

# HANDOFF — agent-engine branch (2026-06-12)

> Branch: `feature/deepagents-agent-engine`. This section is additive; the
> deployment-modes handoff below is unchanged.
>
> **What shipped (packets A-G).** Per-agent agent engine
> (`anthropic_sdk` | `deepagents`) with `modelAlias + agentEngine ->
> executionRoute` resolution. Five engine commits on top of the merged
> deployment-modes work:
>
> - `5a28cae2` Packet A — `AgentEngine` vocabulary (`shared/agent-engine.ts`),
>   engine-keyed `executionRoutes` on the provider registry, settings
>   parse/render/import/export/project for `defaults.agent_engine` +
>   `agents.<id>.agent_engine`, invalid pairings rejected before spawn with locked
>   copy, jobs inherit the bound agent's engine.
> - `851e452d` Packets B+C — `deepagents:langchain` adapter + adapter-owned runner
>   (gateway env allowlist, Claude-OAuth rejection, `streamEvents` v2 →
>   `GANTRY_OUTPUT` frames, runtime-reported context window); CLI `gantry agent
>   engine`, agent list/show engine cell, `model why --agent`; Control API
>   `agentEngine` on agent records + PATCH + model preview `target: 'agent'`;
>   contracts/SDK `AgentEngine`, `ModelRecord.executionRoutes`, optional
>   deepagents-lane limit fields. Deps: deepagents 1.10.2, @langchain/openai 1.4.7,
>   @langchain/anthropic 1.4.0.
> - `5a75a8ce` Packets D+E — authority bridge (provider-neutral tool-gate +
>   permission-IPC extracted to `runner/`; Gantry facade/browser/third-party MCP
>   tools projected through policy; raw DeepAgents authority denied; memory block
>   injected as untrusted prompt context) + route-aware `MemoryLlmClient` (OpenAI
>   chat-completions memory client over the brokered loopback gateway).
> - `ff5f8680` Packet F — jobs/live parity (`_close` mid-stream abort, follow-up
>   buffering, `JOB_HEARTBEAT`), pre-spawn shell/filesystem guard (locked
>   raw-execute copy + data-driven enforcing-sandbox guard behind it),
>   `AGENT_ENGINE_CHANGED` audit + engine diagnostics on `JOB_STARTED`/`RUN_STARTED`
>   + `JobRun.agent_engine`.
> - Packet G (this session) — docs: README (engine concept, `gantry agent engine`,
>   settings example), SDK api-reference (agent `agentEngine`/PATCH, model preview
>   `target: 'agent'`, `executionRoutes`), model-catalog ADR vocabulary,
>   credential-management engine/credential-mode mapping, single-host-hardening v1
>   guard note, new `docs/decisions/2026-06-12-agent-engine-selection.md`,
>   superseded headers on the two goal-prompt docs + handoff plan. Cleanup searches
>   run; no stale "harness is alias-only/internal" language remains in active
>   guidance.
>
> **Decisions reference:** `docs/decisions/2026-06-12-agent-engine-selection.md`
> and the implementation source `docs/architecture/deepagents-agent-engine-handoff-plan.md`.
>
> **Gates (Packet G):** see the PR description / final report for verbatim results.
> Known pre-existing reds (NOT regressions, present on base): `agent-runner-ipc`
> NO_PROXY unit test, `jobs-runs-memory-flow` integration, `runtime-setup-doctor`
> e2e, `canonical-job-repository` `markRunNotified` unit. `check_architecture`
> stays at exit 0 with count-exact provider-boundary exceptions for the public
> engine vocabulary (no checker relaxation).
>
> **Remaining (v1 scope boundaries, by design):** DeepAgents shell/filesystem
> authority disabled (guard fail-closed); the native Anthropic provider exposes a
> DeepAgents api-key route (ChatAnthropic) but OpenRouter has no verified
> ChatAnthropic DeepAgents lane over its Anthropic-compatible projection in v1;
> OpenAI/gpt catalog entries are chat-only; no job- or conversation-level engine
> override.
>
> **Post-gates review round (same session):**
>
> - `8c08abf1` — three-lens adversarial Opus review (correctness/concurrency,
>   security/authority, completeness) over the full branch diff; all confirmed
>   findings fixed: single terminal marker per turn + `sessionInit` frame flag
>   (host no longer misreads the early session frame as turn-complete), stops
>   return without a completed marker, final IPC drain before turn exit, atomic
>   session writes, FS built-ins stripped from the model-visible surface,
>   memory-boundary guard now covers bare-named third-party MCP tools, yolo
>   denylist backstop in the neutral gate, fail-closed credential-mode checks,
>   `gtw_` log redaction, export no longer pins inherited default engines,
>   OpenAI memory cached-token accounting, anthropic-endpoint runner spawn +
>   close-stdin integration tests. Post-fix: unit 3893/3893, deepagents
>   boundary integration 6/6, architecture exit 0.
> - `69b1e2ff` — memory dreaming full-chain integration (evidence → dreaming
>   promotion/review → `memory_search` → fresh-run hydration, DM + channel
>   scopes, 7 tests on disposable pgvector) + a latent `memory_search` fix:
>   the recall-event UPDATE's integer `ELSE 0` arm coerced fractional score
>   params to integer (22P02) and broke every `memory_search` IPC call at the
>   recall-recording step. Note: `jobs-runs-memory-flow` integration is GREEN
>   on this branch against a disposable pgvector container (the pre-existing
>   red was config-specific to the credential branch).
> - OpenAI-family memory lane is implemented but config-unreachable by design
>   (gpt entries chat-only); enabling it is a one-line `supportedWorkloads`
>   catalog decision when wanted.

---

# HANDOFF — deployment-modes branch (2026-06-11, updated 2026-06-12 after the process-roles + multi-live session)

> 2026-06-12 session: the role split (`GANTRY_PROCESS_ROLE`: all|control|live-worker|job-worker)
> AND the former Pending #4 (Phase 4 multi-live cutover) shipped — see
> `docs/decisions/2026-06-12-process-roles-and-multi-live.md`. Live execution is
> distributed across live workers (per-scope durable claims, per-worker
> `live:messages:<workerId>` slots); the singleton live-host lease was replaced by a
> recovery-coordinator lease. Compose/Terraform now deploy differentiated
> control/live-worker/job-worker services. Adversarially reviewed by a three-lens
> Opus panel (correctness/concurrency, security, completeness) — security CLEAN, all
> confirmed findings fixed pre-commit. Gates at commit: build clean, full unit
> 3653+/3653+, Postgres integration green on disposable pgvector (incl. the
> two-process claim e2e), architecture findings exactly at the pre-existing 67
> baseline (Pending #2 below still owns that debt). The Pending #1
> live-horizontal-execution "prompt resolutions to the recovered owner" failure was
> ROOT-CAUSED AND FIXED in this branch (pending-interaction re-prompt upsert
> clobbered the stored callback route to null; now COALESCEd).

Session handoff for continuing on another machine. Delete this file once the
items below are absorbed into PRs/issues. Branch: `feature/deployment-modes`
on top of `feature/mworker-01-safe-multi-worker-execution`'s `bdf86d2f`.
Former Pending #1 (typed settings wire contract), #2 (SDK docs), and the
buildable half of #4 (chaos-combo test + two-process e2e) were completed in
the continuation session — see the DONE table.

## What is DONE (implemented, adversarially reviewed, committed, gates run)

| Phase | Content | Commits |
|---|---|---|
| 0 | 5 ADRs (`docs/decisions/2026-06-11-*.md`), `docs/architecture/deployment-profiles.md`, `TODOS.md` | `3ca459a0` |
| 1 | Locked agent preset: `agents.<id>.access.preset: full\|locked`; parent-side denial on BOTH IPC ingestion loops (`denied_by_profile`), tri-state fail-closed lock lookup, `permissionMode: deny`, CLI verb. Later extended: policy-aware instruction projection + provisioned-only introspection for locked agents | `697cde1c`, `193710d1`, `5ba942ce` |
| 2 | Packaging: `/healthz` `/readyz` `/metrics`; SIGTERM drain (`runtime.queue.drain_deadline_ms`); load-bearing lease-elected live host (in-process standby takeover); Node 24 image (python3 + bubblewrap, non-root); advisory-locked migrations (single lock incl. boot-time); GHCR CI w/ SBOM+Trivy; Terraform (network/db/storage/secrets/worker_pool/control + fleet/support envs); AWS runbook | `160e2c2f`, `5a1a6760` |
| 3 | Fleet capability state: migration 0077 (`runtime_dependencies`, `settings_revisions`); S3 artifact driver (sha256, quarantine); npm bake jobs (`--ignore-scripts`, registry-pinned, idempotent, reaper-recovered); worker reconciler + `capabilities_json` advertising; capability-matched dispatch (requeue w/o retry burn, recovery filter, fleet-wide-only readiness pause, starvation alert+pause); settings revisions + desired-state control API + SDK; CLI (`settings validate\|import\|export\|drift\|revisions`, `workers list`, `bake status\|rebake`, `artifacts quarantine list\|purge\|rebake`); fleet boot gated on first revision; `GANTRY_SECURITY_POSTURE` rename (clean cut) | `f20ba11a`, `c4f22aac`, `4bfae3b0`, `f5d95ece`, `2e03596e`, `8be9014c`, `89d4a2dc` |
| Ops/docs follow-ups | Single autoscaled fleet pool (lease elects live host; min ≥ 2); CPU target-tracking autoscaling; worker-configuration reference (sandbox resource limits + sizing rule); vertical-vs-horizontal scaling decision guide | `3793eeec`, `d5b2454b`, `f005605d` |
| Continuation | Typed settings document wire contract for the desired-state API/SDK (`settingsYaml` eliminated; YAML confined to workstation file + CLI `--file` edge; `SettingsDocument` in contracts; `settings_revisions` stores the bare snake_case document); SDK docs rewrite (deployment shapes, desired-state contract, locked preset, ops endpoints — all claims source-verified; nonexistent `client.memory.sources.*` removed); chaos-combo fleet-capability integration test + true two-OS-process claim-protocol e2e (no production changes); parser file-size budget fix | `61ab50f9`, `a9f171d7`, `836c551f`, `a9fc3c03` |

Review trail: per-phase adversarial Opus reviews. Found+fixed pre-commit: Phase 1
permission-loop authority bypass (P0-class) and fail-open lock lookup; Phase 2
decorative live-host lease (P1); Phase 3 stuck-`baking` rows never recovering +
SIGTERM-mid-bake stranding (2×P0), settings 409 check-then-act race (P1), plus
P2s (quarantine path collision, locked-projection residuals, rebake CAS).
Security verdict: CLEAN. Continuation session kept the same pattern: each of the
three work items got its own adversarial Opus review pre-commit (all
COMMIT-READY; fixed pre-commit: a vacuous boot-gate assertion in the chaos test,
the file-size budget breach, lockfile churn, and an overstated "lossless"
comment — the round-trip escaping limit is now a TODOS.md row). Hard gates at
post-review fixes: `npm run build` clean; `npm test` 3611/3611 unit and
53/53 integration tests passed;
`python3 .codex/scripts/verify.py` fails in `check_architecture` with output
byte-identical to base `975bb6c1` (pre-existing boundary debt + file budgets,
none introduced by this branch's continuation work), which in turn makes
`validate_artifacts.py` fail on `verify.json ok:false`. Postgres integration
suites + both new tests proven against a disposable pgvector container on this
machine too. Final whole-diff closeout review with the autoreview helper is
clean after the fixes in section 7: no remaining introduced correctness,
security, or regression blockers.

User decisions binding on all future work (see also memory/ADRs): no skill
versioning; YAML is ONLY the personal/workstation+CLI-file surface; no legacy
affordances ever (no deprecation aliases, no rename guards); Terraform/AWS
first; single autoscaled pool; Go toolchain stays out of the image.

2026-06-12 ENG-124 handoff update: DeepAgents integration planning is now
captured in `docs/architecture/deepagents-agent-engine-handoff-plan.md`. The
binding product decision is that users choose a per-agent `agentEngine`
(`anthropic_sdk` or `deepagents`) while models remain selected by `modelAlias`;
the model provider route decides whether the endpoint family is `anthropic` or
`openai`. Jobs and conversations inherit the bound agent's engine. Do not add
public `job.harness`, job-level `agentEngine`, job-level `executionProviderId`,
raw provider model ids, or provider-native tool/backend names.

## PENDING (in priority order)

### 1. Pre-existing BASE-BRANCH defects (block merge gates; owned by `feature/mworker-01-safe-multi-worker-execution`, NOT this branch — both verified to fail with this branch's work stashed)
- `apps/core/test/unit/runtime/message-loop.test.ts` "passes non-self sender ids with continuation batches" — fixed after closeout review by aligning the test with the cursor-carrying continuation contract.
- `apps/core/test/integration/live-horizontal-execution.integration.test.ts` "delivers prompt resolutions to the recovered owner after adapter restart" — FIXED in this branch (2026-06-12 session): the pending-interaction re-prompt upsert clobbered `callback_route_json` to null when the re-prompt omitted the route; the update now COALESCEs to preserve the durable route. Test green under Postgres.

### 2. Architecture-check debt — RESOLVED (2026-06-12 session)
`check_architecture.py` now exits 0 and `verify.py` + `validate_artifacts.py
--allow-missing-run` pass END-TO-END (with a disposable Postgres for the
test/e2e stages). Mix of genuine removals (infrastructure/logging reclassified
to the shared layer; `RuntimeDeploymentMode` and the authority-changing tool
names moved to shared, breaking runtime→config and config→runner edges) and
time-bounded ratchet exceptions (exact no-headroom caps, reasons,
`removeByPhase: canonical-boundary-cleanup-phase`) for the structural cluster
— the burn-down ledger is `.codex/architecture-exceptions.json`. Also fixed
en route: drizzle-wrapped 23505 detection (message-redelivery dedupe +
outbound idempotency retries never fired), and fleet boot coherence (compose
seeded `provider: direct` under production posture, which the security gate
rejects — now `sandbox_runtime` + seccomp option; see the TODOS hardening row).
Same session also shipped the cross-worker browser profile snapshot store and
control-role manual job triggers (send-only pg-boss client) — see
`git log 09c29188..` and TODOS.

### 3. Plan acceptance items never executed
- Measured runbook walkthroughs: local compose → first turn ≤ 15 min; clean AWS account → first locked support-agent turn ≤ 60 min. Documented, never timed end-to-end.
- Real AWS deploy has never been applied (terraform validate-only so far).
- (The chaos-combo integration test and the two-process e2e from this list were built in the continuation session — `836c551f`. Note the e2e runs under `npm run test:e2e` (separate vitest config), which is not part of the default `npm test` gate; wire it into CI if the claim-protocol proof should gate merges.)

### 4. Phase 4 — DONE (2026-06-12 session)
Multi-live cutover shipped together with the process-role split; see the header
note and `docs/decisions/2026-06-12-process-roles-and-multi-live.md`. The
browser-profile snapshot/restore TODOS row is now ACTIVE (its trigger fired:
browser-bearing turns can land on different live workers).

### 5. TODOS.md near-term flags (full list in TODOS.md, each with triggers)
- Fleet container sandbox enablement (`sandbox_runtime` in Docker: seccomp/userns + doctor check) — REQUIRED before the first production fleet running public-facing agents; until then fleet keeps `runtime.sandbox.provider: direct`.
- Locked-agent unmet-need telemetry + human handoff (support product layer) — locked agents currently produce zero demand signal.
- pip bake lane; pinned-binary bake lane; CLI dry-run missing-OS-dep report; live-conversation auto-resume after bake; subagent-aware run slots; fleet management UI on the desired-state API.
- NEW (continuation review finding): simple-YAML codec escaping fidelity (`"`/`\` in string values; float-as-string in the document) — see the TODOS.md row.

### 6. Merge path
PR `feature/deployment-modes` → likely stacked on `feature/mworker-01-...`
(this branch contains it). Repo hard gates (AGENTS.md): `npm run build` (clean),
`npm test` (clean after closeout fixes), `python3 .codex/scripts/verify.py` and
`python3 .codex/scripts/validate_artifacts.py --allow-missing-run` (both
blocked by Pending #2). The repo's Codex-factory artifacts (`.factory/*`,
gitignored machine-local) were NOT produced via the factory flow — this work
ran as a reviewed-subagent implementation; produce them or waive per team
policy.

### 7. Closeout review fixes landed after this handoff
- Scheduler pg-boss workers no longer spin indefinitely while waiting for a saturated cluster run slot; blocked deliveries are requeued without consuming job retry budget.
- Ineligible scheduler deliveries now fail closed if requeue cannot be persisted.
- Fleet Terraform now requires TLS for public control/webhook ingress and redirects HTTP to HTTPS only.
- Worker bootstrap writes the env file at `0600` before resolving Secrets Manager values and rejects newline-bearing env-file secrets.
- Toolchain artifacts preserve executable modes and relative symlinks so npm `.bin` entries survive bake/materialize; S3 artifact stores batch prefix deletes and fail on per-key delete errors.
- Shutdown drain no longer aborts when queue/browser/channel teardown rejects.
- SDK settings response types were realigned with the public contracts `sources` + `capabilities[]` shape.

## Context locations
- Repo-resident truth: ADRs `docs/decisions/2026-06-11-*.md`; `docs/architecture/deployment-profiles.md` (mode matrix, worker config, scaling guide); `docs/deployment/aws-terraform.md`; `TODOS.md`.
- Machine-local (original workstation only, optional): approved plan `~/.claude/plans/analyse-the-current-repo-swirling-quill.md`; CEO review doc `~/.gstack/projects/vrknetha-myclaw/ceo-plans/2026-06-11-deployment-profiles.md`. Everything needed to continue is in-repo.
