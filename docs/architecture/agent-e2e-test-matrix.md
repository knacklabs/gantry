# Agent E2E / Integration Test Matrix

Tracking doc for the E2E gate (goal: `agent-e2e-ci-merge-gate-goal-prompt.md`).
Add rows freely — this is the living checklist the implementer works from.

## Discipline (applies to every row)

1. **Behavioral assertions only** — assert tool CALLS (structured args), fixture
   records, DB rows, runtime events, state transitions. NEVER model phrasing,
   never NL snapshots.
2. **Testing ladder** — public API where one exists → in-process service where
   none does → NEVER a test-only endpoint.
3. **Ponytail** — the MINIMUM scenarios that prove the behavior; no speculative
   cases; reuse existing coverage (cite it, don't rebuild it).
4. **Layer rule** — deterministic logic = integration (fast, no model creds,
   every PR); composed proof = e2e (real image + real haiku turn, every PR);
   expensive/external = e2e-live (label-gated).
5. **Isolation** — e2e runs build a fresh GANTRY_HOME + disposable DB from
   scratch, never `~/gantry`, never the live DB. Fresh onboarding via API each
   run.
6. **No change-detector tests** (adopted from Hermes) — never assert a snapshot
   of current data (a specific model in the catalog, an enum count, a config
   version). Assert INVARIANTS and relationships ("catalog plumbing resolves an
   alias to a routable model"), so data churn doesn't break tests. And never
   read source-code text in a test (the scoped i-have-adhd guard over E2E
   fixture surfaces is the sole, documented exception).
7. **Env hygiene in deterministic lanes** (adopted from Hermes) — the harness
   pins `TZ=UTC`/`LANG=C.UTF-8` and UNSETS all model-credential env vars for
   non-live lanes, so a deterministic test can never accidentally reach a
   provider.
8. **Live-test naming** (adopted from OpenClaw) — label-gated live tests use
   the `*.live.test.ts` suffix + their own config, same convention mechanism as
   the postgres lanes; live lanes carry per-provider concurrency caps.

Legend: ✅ covered (cite) · 🔨 to build · 🏷 label-gated (live lane) · 💤 deferred

## 1. Runtime & boot

| Scenario                                                                                                                                                                 | Layer                   | Status                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------- |
| Image starts, migrations current, healthy                                                                                                                                | e2e                     | 🔨                                                 |
| Restart preserves desired state (settings revision projection)                                                                                                           | e2e                     | 🔨                                                 |
| Security posture: prod image requires enforcing sandbox + non-prod secrets                                                                                               | integration             | ✅ security-posture.test.ts                        |
| Harness refuses to run against ~/gantry or live DB (isolation guard)                                                                                                     | e2e (harness self-test) | 🔨                                                 |
| **Upgrade survivor** (adopted from OpenClaw): boot version N-1 state (settings revisions + DB) under version N image → migrations apply → agents/bindings/grants survive | e2e                     | 🔨 (post-ponytail-cutover — baseline resets first) |
| Startup benchmark lane (boot time / first-turn latency budgets)                                                                                                          | perf                    | 💤 deferred until the gate is stable               |

## 2. Onboarding & model selection (API-driven)

| Scenario                                                                                       | Layer             | Status                         |
| ---------------------------------------------------------------------------------------------- | ----------------- | ------------------------------ |
| Create agent + conversation binding via desired-state API; revision appended; survives restart | e2e               | 🔨                             |
| Select `haiku` alias; turn evidence routes to selected model/provider/harness                  | e2e               | 🔨                             |
| API contract: status codes + response shapes on onboarding endpoints                           | e2e (same pass)   | 🔨                             |
| Scope enforcement: sessions-only key → 403 on admin endpoint                                   | integration       | 🔨                             |
| `sessions/ensure` honors `agentId` (bug fix first)                                             | integration + e2e | 🔨 blocked on ponytail landing |

## 3. Agent turn (haiku, behavioral)

| Scenario                                                                          | Layer | Status |
| --------------------------------------------------------------------------------- | ----- | ------ |
| ensure → message (202 ≠ done) → events → visible completion                       | e2e   | 🔨     |
| Evidence bundle complete (ids, alias/route, timings, audit ids, redacted failure) | e2e   | 🔨     |
| Inline-lane turn (LLM API path) completes once                                    | e2e   | 🔨     |
| Turn-failure surfaces cleanly (bad model alias → clean terminal state, no zombie) | e2e   | 🔨     |

## 4. Skills

| Scenario                                                                                                                                                                                                  | Layer                | Status                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------- |
| Install vendored `internal-comms` zip via `/v1/skills/install`; catalog + binding identity                                                                                                                | e2e                  | 🔨                                          |
| Selection survives restart; assets materialize incl. `examples/3p-updates.md` (progressive disclosure)                                                                                                    | e2e                  | 🔨                                          |
| Turn produces 3P STRUCTURE (Progress/Plans/Problems sections exist — structure, not wording)                                                                                                              | e2e                  | 🔨                                          |
| `gantry-admin` reserved name rejected by install API                                                                                                                                                      | integration          | 🔨                                          |
| `admin_permission_list` callable, returns expected shape                                                                                                                                                  | e2e                  | 🔨                                          |
| **Agent-driven skill acquisition**: turn asks the agent to get itself a skill → `request_skill_install` → REAL approval path → installed+selected → follow-up turn USES it (materialized assets asserted) | e2e (haiku, Stage C) | 🔨                                          |
| Skill install/registry logic                                                                                                                                                                              | integration          | ✅ skills-registry-flow.integration.test.ts |

## 5. MCP

| Scenario                                                                                                                                                                                                                                        | Layer                | Status                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Register HTTP server via SDK; approve ONLY echo+get-sum                                                                                                                                                                                         | e2e                  | 🔨                                                                                                                                               |
| Discovery + schema; denied tools invisible to the agent                                                                                                                                                                                         | e2e                  | ✅ mcp-client-loop.postgres.e2e.test.ts                                                                                                          |
| Turn calls `get-sum(20,22)`; fixture records call; tool result 42; MCP audit event                                                                                                                                                              | e2e                  | ✅ client path (non-model: fixture records exact args, result 42, MCP audit + runtime event) mcp-client-loop.postgres.e2e.test.ts · 🔨 real-turn |
| stdio transport                                                                                                                                                                                                                                 | integration          | ✅ ipc-mcp-stdio.test.ts                                                                                                                         |
| MCP server management lifecycle                                                                                                                                                                                                                 | integration          | ✅ mcp-server-management.integration.test.ts + mcp-server.postgres.integration.test.ts                                                           |
| Deep-MCP: every capability class of vendored everything-server (tools, resources, prompts, sampling, progress, logging, completions) — unsupported class = product bug or documented non-support                                                | e2e-live             | 🏷                                                                                                                                               |
| **Agent-driven MCP acquisition**: turn asks the agent to get itself the fixture MCP server → agent calls `request_mcp_server` → REAL approval path decides → server registered+bound → follow-up turn agent CALLS its tool (fixture records it) | e2e (haiku, Stage C) | 🔨                                                                                                                                               |
| Agent-driven acquisition via CHAT (Slack): same loop driven by a channel message + button approval                                                                                                                                              | e2e-live             | 🏷                                                                                                                                               |
| Inventory-only bound server projects next turn even when other `mcp__` rules are selected (defect 1)                                                                                                                                            | integration          | ✅ mcp-authorized-servers.test.ts (#237/develop R3)                                                                                              |
| Reviewed `mcp_pattern` capability is the single action authority: projection + call-time enforcement; denial names the missing capability, recovery strings mode-aware (defect 2)                                                               | integration          | ✅ mcp-tool-proxy.test.ts, locked-tool-surface.test.ts, locked-introspection.test.ts (#237/develop R2)                                           |
| Reconcile preserves agent-installed active bindings unless explicitly removed; inactive-server rows warn+skip (defect 6)                                                                                                                        | integration          | ✅ settings-desired-state-service.test.ts, ipc-runtime-admin-handlers.test.ts (#237/develop R3)                                                  |
| Install-time materialization collision rejected at install with honest receipt, not at next spawn (defect 3)                                                                                                                                    | integration          | ✅ ipc-skill-permission-review.test.ts, skill-service.test.ts (#237/develop R3)                                                                  |
| `mcp_search_tools` FTS over inventory (names+descriptions+server); semantic-ready interface                                                                                                                                                     | integration          | ✅ mcp-proxy-tools/service tests (#237/develop R3) · 🔨 haiku turn uses it to find+call a fixture tool                                           |

## 6. Permissions (granular)

| Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Layer                               | Status                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask`: eligible tool → human prompt, nothing auto-decided                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | integration                         | ✅ permission-classifier tests                                                                                                                                                                 |
| `auto`: read-only gate as evidence → classifier allow → auto_classifier allow_once                                                                                                                                                                                                                                                                                                                                                                                                                                                     | integration                         | ✅ permission-classifier.test.ts:539-612                                                                                                                                                       |
| `auto_strict`: unproven-safety asks WITHOUT classifier; proven still consults strict classifier                                                                                                                                                                                                                                                                                                                                                                                                                                        | integration                         | ✅ permission-classifier.test.ts:614-667                                                                                                                                                       |
| Classifier unavailable/failure → fail-safe ask                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | integration                         | ✅ unit                                                                                                                                                                                        |
| YOLO denylist hit → ask + event; unattended converts to denial                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | integration                         | ✅ classifier.test.ts:868-941 (attended); 🔨 unattended-context chain                                                                                                                          |
| Locked agent: forged authority IPC denied at parent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | integration                         | ✅ ipc-locked-permission-denial.test.ts                                                                                                                                                        |
| Eligibility: only Bash/RunCommand + non-gantry MCP reach classifier                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | integration                         | ✅ unit                                                                                                                                                                                        |
| Full chain: real IPC boundary → durable interaction → decision → event repo                                                                                                                                                                                                                                                                                                                                                                                                                                                            | integration                         | 🔨 (the one genuinely new chain)                                                                                                                                                               |
| Allow ONCE: run-scoped transient grant issued under the REAL claimed run lease (channel-callback decision → `applyPendingInteractionGrantDecision` → `recordRunScopedTransientGrant`), readable via the lease-fenced read model; no durable binding, no settings mirror write, durable gate denies even while the grant is live; unreadable after the lease settles + fresh services                                                                                                                                                   | integration + e2e recovery scenario | ✅ integration permission-durable-authority.postgres.integration.test.ts (grant issuance/expiry; does NOT prove the live tool-call resume — that is the IPC processor's job) · 🔨 e2e recovery |
| Allow FUTURE: EXACT argv-leaf rule (asserted string equality against the input command) persisted through the REAL settings mirror (`createAgentToolRuleSettingsMirror` → settings.yaml + settings revision + desired-state reconcile); auto-allows the same leaf, denies same-executable-different-args and other executables; survives restart via REAL startup reconciliation over authoritative settings (DB-only bindings are wiped, so survival proves the mirror); agent-scoped — a second configured agent never sees the rule | integration                         | ✅ permission-durable-authority.postgres.integration.test.ts                                                                                                                                   |
| Record-before-prompt ordering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | integration                         | 🔨                                                                                                                                                                                             |
| Cancel: run interrupts cleanly, no partial effect, audit `cancelled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | integration                         | ✅ decision chain (cancelled record, no rule persisted) permission-durable-authority.postgres.integration.test.ts · 🔨 run-interrupt                                                           |
| Deny: recorded, no execution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | integration                         | 🔨                                                                                                                                                                                             |
| NO chat receipt on allow-future (regression, #239)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | integration                         | 🔨                                                                                                                                                                                             |
| Real decision paths only — via classifier / in-process button-resolution callback / real Slack button (never a decide-API)                                                                                                                                                                                                                                                                                                                                                                                                             | (constraint on all above)           | —                                                                                                                                                                                              |
| Whole-chain credential-absence in events/logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | integration                         | 🔨                                                                                                                                                                                             |

## 7. Capabilities

| Scenario                                                                                          | Layer       | Status                                               |
| ------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| Declare via settings surface → `capability:<id>` + scoped RunCommand rule projection              | integration | ✅ configured-agent-tools.test.ts                    |
| local_cli pinning (path/version/hash/templates); unrelated command denied                         | integration | ✅ semantic-capabilities.test.ts                     |
| Persisted selected binding → projection → real admission                                          | integration | 🔨                                                   |
| Real-image preflight pass AND fail-closed                                                         | e2e         | 🔨                                                   |
| Secret lifecycle store→retrieve→rotate→audit (all four in one test)                               | integration | 🔨                                                   |
| Tampered ciphertext → integrity error → capability unavailable, no plaintext leak                 | integration | ✅ capability-secret units; 🔨 through-sandbox chain |
| Egress: denylist blocks + `egress.connect` attribution (networkHosts = attribution NOT allowlist) | integration | ✅ egress-gateway.test.ts; 🔨 e2e with fixture pair  |
| Real gog/Sheets tier (throwaway sheet)                                                            | e2e-live    | 🏷                                                   |

## 8. Memories

| Scenario                                                                         | Layer              | Status                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Write → recall → subject-boundary isolation (person/group/channel)               | integration        | ✅ memory-write-recall-boundary.postgres.integration.test.ts (subject-scoped fetch recall; embedding recall stays hermetically disabled) |
| Turn 1 states fact → durable memory row collected; turn 2 → memory READ occurred | e2e                | 🔨                                                                                                                                       |
| Memory survives restart, still recallable                                        | e2e                | 🔨                                                                                                                                       |
| Job-run memory collection persists                                               | e2e (job scenario) | 🔨                                                                                                                                       |

## 9. Jobs

| Scenario                                                                                                  | Layer                                     | Status                                    |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Create via API → trigger → run completes → delivery → health `completed` (API twin of agent-job-smoke.sh) | e2e                                       | 🔨                                        |
| Pause → resume → trigger transitions + events                                                             | e2e                                       | 🔨                                        |
| Forced failure exhausts retries → dead-letter + clean terminal event                                      | e2e                                       | 🔨                                        |
| Autonomous tool dead-end: ungranted tool surfaces cleanly (regression)                                    | integration                               | 🔨                                        |
| MCP-readiness race: slow init must NOT hard-fail (regression, fix on main)                                | integration (unit exists) + e2e real-turn | ✅ mcp-server-validation.test.ts · 🔨 e2e |
| Local live smoke against the real runtime                                                                 | manual/script                             | ✅ scripts/agent-job-smoke.sh             |

## 10. Attachments & delivery

| Scenario                                                                                 | Layer       | Status |
| ---------------------------------------------------------------------------------------- | ----------- | ------ |
| Turn sends the deterministic attachment → workspace-direct delivery record, hash matches | e2e         | 🔨     |
| Oversize handling (>25MB refused cleanly)                                                | integration | 🔨     |
| Webhook fires with expected payload shape (loopback receiver)                            | e2e         | 🔨     |

## 11. Route integrity (incident regressions)

| Scenario                                                                                                                                                                           | Layer            | Status                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Loader collapses mixed legacy key forms to ONE route (total preference order)                                                                                                      | unit/integration | ✅ canonical-binding-repository.test.ts, settings-desired-state-service.test.ts, thread-queue-key.test.ts              |
| Divergent conversationId rows load via retain+warn, never throw, never drop a chat                                                                                                 | unit/integration | ✅ canonical-binding-repository.test.ts (divergent/corrupt-row cases), ipc-locked-agent-denial.test.ts                 |
| Corrupt-state seed via direct test-DB rows (documented API exception)                                                                                                              | integration      | 🔨                                                                                                                     |
| Providerless admission qualifies conversation/message/queue with ONE provider account (no silent turn drop, no parallel conversation)                                              | unit/integration | ✅ canonical-message-ops-service.test.ts, message-loop.test.ts, live-admission-work-items.postgres.integration.test.ts |
| API-session (`app:` JID) admission stamps the internal channel account `control:<appId>` so channel ownership matches and the turn spawns (was: "No channel owns JID" silent skip) | unit             | ✅ canonical-message-ops-service.test.ts (app-session admission)                                                       |

## 12. Channel loop (Slack, dedicated test app)

| Scenario                                                                                      | Layer    | Status                                                                   |
| --------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Real user-pattern message → agent turn → outbound reply in channel                            | e2e-live | 🏷                                                                       |
| Permission block renders (header/context structure); approve callback → tool proceeds + audit | e2e-live | 🏷 (needs real-user or signed-callback fixture — constraint per round-3) |
| Attachment delivered in channel                                                               | e2e-live | 🏷                                                                       |

## 13. Model matrix & policy gate

| Scenario                                                                                 | Layer         | Status |
| ---------------------------------------------------------------------------------------- | ------------- | ------ |
| `haiku` + anthropic_sdk turn (required gate)                                             | e2e           | 🔨     |
| `gpt-mini` + deepagents turn                                                             | e2e-live      | 🏷     |
| Catalog base/head diff adds changed aliases to live matrix                               | CI policy job | 🔨     |
| Path-map classifies changed paths; UNKNOWN stays risky; `e2e-reviewed` acknowledges only | CI policy job | 🔨     |
| `agent-e2e-gate` aggregates + branch protection verified                                 | CI            | 🔨     |

## 14. All-tools sweep

| Scenario                                                                                                                                                               | Layer | Status                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- |
| Enumerate effective tool set (internal inspector); every read-only + fixture-backed tool invoked once; call + effect + audit asserted; unreachable granted tool = FAIL | e2e   | 🔨                                                                                  |
| Authority/lifecycle tools covered by their own scenarios (not blind invocation)                                                                                        | —     | design rule                                                                         |
| Browser tool against loopback page                                                                                                                                     | e2e   | 🔨 (image lacks Chrome — runs in local smoke until media-render ships provisioning) |

## 15. Multi-agent, delegation & elevated access (user, 2026-07-20)

| Scenario                                                                                                                                                                                                                                 | Layer                                   | Status                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| **Elevated access loop**: agent hits a denied operation → calls `request_access` (scoped target) → REAL approval path grants → durable grant persisted (revision) → retry succeeds → grant survives restart; denied variant stays denied | e2e (haiku) + integration chain         | 🔨                                                                                 |
| **Subagent delegation**: turn delegates via `AgentDelegation` to the fixture target agent → delegated turn runs → result returns to the parent turn → both runs + linkage in evidence/audit                                              | e2e (haiku)                             | 🔨                                                                                 |
| Delegated/async task lifecycle plumbing (create → run → complete → result surfaced; failure → clean terminal state)                                                                                                                      | integration                             | ✅ partial: ipc-agent-task-lifecycle units; 🔨 durable chain through repos         |
| **Async task**: agent starts async work → turn ends → task completes later → completion notification/result recorded (quiet-until-terminal rule respected)                                                                               | e2e                                     | 🔨                                                                                 |
| **Bash/RunCommand real execution**: agent runs a scoped command in the worker sandbox → output captured in turn → permission decision + audit recorded (beyond the sweep: asserts output round-trip)                                     | e2e (haiku)                             | 🔨                                                                                 |
| **Agents-as-tools**: agent invokes another agent as a TOOL (not delegation) and consumes its structured result                                                                                                                           | e2e                                     | 🔨 (verify feature state first — agents-as-tools lane; row activates when shipped) |
| **Two agents, one conversation**: two installed agents with distinct triggers → message for A runs ONLY A; message for B runs ONLY B; no cross-talk; routes stay disambiguated (incident-regression adjacent)                            | integration (routing) + e2e-live (chat) | 🔨 / 🏷                                                                            |
| Two agents: permission prompt from A answered → grants apply to A only (scope isolation across co-resident agents)                                                                                                                       | integration                             | 🔨                                                                                 |

## 16. Security & recovery

| Scenario                                                         | Layer     | Status |
| ---------------------------------------------------------------- | --------- | ------ |
| Skill+MCP selections survive restart; allow_once does NOT        | e2e       | 🔨     |
| Logs + evidence credential-scrubbed (whole run grep)             | e2e       | 🔨     |
| Fork PRs never see secrets (workflow config review)              | CI review | 🔨     |
| i-have-adhd zero references (scoped guard, fragment-built token) | unit      | 🔨     |

## 17. Orphan suites (never ran in CI — adopt deliberately)

| Suite                                               | Status                                               |
| --------------------------------------------------- | ---------------------------------------------------- |
| live-waiting-admission.postgres.integration         | 💤 excluded-by-name; adopt = delete one exclude line |
| pattern-candidate-atomic-claim.postgres.integration | 💤 same                                              |
| proactive-surfacing-opt-in.postgres.integration     | 💤 same                                              |
| toolchain-bake-reconciler.postgres.integration      | 💤 same                                              |
| worker-coordination.postgres.integration            | 💤 same (known flaky-under-load heartbeat test)      |

## Add new scenarios below

| Feature | Scenario | Layer | Notes |
| ------- | -------- | ----- | ----- |
|         |          |       |       |
