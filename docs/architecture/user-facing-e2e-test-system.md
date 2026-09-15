# User-Facing E2E Test System

Status: Wave 1 foundation implemented. Protected model and messenger lanes are
proposed and require the dedicated actors and credentials listed below.

This document defines how Gantry proves user-visible journeys. The executable
coverage and implementation status remain in
[`agent-e2e-test-matrix.md`](./agent-e2e-test-matrix.md). We extend the existing
`apps/core/test/agent-e2e/` harness; we do not create another test framework.

## Product model

A user-facing E2E test drives Gantry through the same public API or messenger a
user uses, follows the journey across real runtime boundaries, and verifies the
durable outcome without depending on exact model wording.

The test controller owns setup and the verdict. An optional supervisor agent
may act as the external user through approved MCP tools, but it does not decide
whether Gantry passed.

## Goals

- Catch breakage in core user journeys before users do.
- Prefer deterministic API, event, database, tool-call, and delivery evidence.
- Exercise the packaged runtime with a fresh `GANTRY_HOME` and disposable
  Postgres database.
- Add protected real-model and real-messenger proof where a hermetic test cannot
  establish the boundary.
- Keep pull-request checks fast and credential-free.
- Produce redacted evidence that explains a failure without rerunning it.

## Non-goals

- Testing every permutation through every messenger.
- Treating model prose as a stable snapshot.
- Calling production workspaces, chats, accounts, or databases.
- Replacing focused unit and integration tests.
- Adding an LLM judge when structured evidence can decide the result.
- Testing provider infrastructure availability as if it were Gantry behavior.

## Test lanes

| Lane                      | Runs                                           | Dependencies                                                           | Purpose                                                          |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Deterministic integration | every PR                                       | local process or disposable Postgres                                   | Contracts, policy, persistence, adapters, and failure cases      |
| Hermetic packaged E2E     | nightly and manual                             | built Gantry runtime, disposable Postgres, local fixtures              | Multi-step public-API journeys without external credentials      |
| Protected model E2E       | scheduled/manual protected runs                | packaged runtime and dedicated model credential                        | One real turn, routing, tool use, usage, and failure evidence    |
| Protected channel E2E     | scheduled/manual, one provider per job         | dedicated test workspace/account/chat and model credential when needed | Inbound message through Gantry to visible provider delivery      |
| Semantic evaluation       | only inside a protected scenario that needs it | separate inexpensive judge model                                       | Bounded meaning check when no stable structured assertion exists |

The slow or credentialed lanes supplement deterministic coverage. They do not
replace it and do not run on untrusted fork pull requests.

### Protected Claude credential

The protected real-model lane uses a Claude Code subscription token rather than
an Anthropic API key:

1. An authorized maintainer runs `claude setup-token` locally.
2. The token is stored as the GitHub repository secret
   `E2E_ANTHROPIC_API_KEY`.
3. The workflow maps that secret only into the real-model step as
   `E2E_MODEL_API_KEY`.
4. The scenario stores it through `PUT /v1/credentials/models/anthropic` using
   `authMode: claude_code_oauth`; it is never placed in a fixture, log, or
   uploaded evidence.

Forks and untrusted pull requests do not receive this secret and therefore skip
the protected model lane without weakening the hermetic E2E result.

## Gantry target contract

The default target is a real Gantry server managed by the existing harness:

- `AGENT_E2E_RUNTIME_ROOT` points to the Gantry checkout containing the built
  runtime and migration entrypoints (the current checkout is the default);
- `GANTRY_TEST_DATABASE_URL` points to an admin database on a throwaway
  Postgres server; the harness creates and drops a unique database per run;
- the harness creates a fresh temporary `GANTRY_HOME`, generated secrets, and
  scoped Control API keys;
- the harness starts Gantry, waits for `/readyz`, and gives the scenario its
  server URL and API keys;
- the scenario then behaves as an external user through public APIs or a live
  messenger.

This is a managed black-box target: setup and teardown can inspect the isolated
home/database, but scenario actions use public surfaces. Connecting destructive
scenarios to an arbitrary already-running server is deferred because the runner
cannot prove ownership or clean up its home/database. An attached-server mode
should be added only with an explicit disposable-target identity contract; it
must never accept a normal workstation or production server by URL alone.

## Scenario contract

Every new scenario records these fields in its test or adjacent matrix row:

1. **ID and user outcome** — the user-visible promise being protected.
2. **Lane and actor** — API client, controlled messenger user, or runtime.
3. **Preconditions** — fixtures, model alias, scopes, and required secrets.
4. **Public steps** — the ordered API or provider actions a user can perform.
5. **Pass evidence** — events, rows, tool calls, API relationships, and visible
   delivery; never exact prose.
6. **Cleanup** — database, temporary home, messages, files, and provider state.
7. **Time budget** — fail rather than wait indefinitely.
8. **Evidence output** — redacted request IDs, session/run IDs, phase timings,
   terminal events, delivery IDs, and failure detail.

A scenario is E2E only when it crosses multiple real components. A single
function or service contract belongs in unit or integration coverage.

## External supervisor and MCP actor drivers

Live channel tests need an actor outside the Gantry instance under test. That
actor may be:

- a deterministic provider client;
- a configured MCP server exposing the required provider operations; or
- a bounded supervisor agent using those MCP tools when the interaction cannot
  be expressed as fixed calls.

Vitest remains the controller in every case. It creates a unique correlation
token, gives the actor the exact destination and action, waits with a fixed
timeout, queries Gantry's public API evidence, and decides the result. The actor
returns structured provider evidence such as workspace/account, conversation,
thread/topic, sender, message ID, timestamp, and cleanup result.

For a normal Slack or Telegram message, direct MCP tool calls are preferred over
an LLM supervisor because sending, reading, and deleting a known message are
deterministic operations. A cheap supervisor model is justified only for an
interaction that genuinely requires interpretation or flexible navigation. It
gets an allowlist containing only the required test-account tools, a small turn
and time budget, and no access to production conversations.

There are two separate MCP test directions:

1. **MCP as test transport:** the external controller/supervisor uses a Slack,
   Telegram, or other provider MCP server to send and observe messages around
   Gantry.
2. **MCP as Gantry functionality:** the Gantry agent under test discovers and
   calls an MCP server, while the fixture records its tool name, arguments, and
   result.

One direction does not prove the other. Each provider scenario declares its
required actor capability and exact tool schema. "Any available messenger" may
be used for a generic supervisor smoke test, but Slack coverage cannot satisfy a
Telegram row or vice versa. In a protected scheduled lane, a missing declared
MCP/provider capability is a configuration error rather than a passing skip.

Example Slack sequence:

1. Vitest creates correlation token `E2E-<run-id>`.
2. The Slack actor sends a tagged message to the dedicated test channel.
3. Gantry ingests it, creates the expected session/run, and delivers a reply to
   the same thread.
4. The Slack actor reads the thread and returns message metadata.
5. Vitest correlates that metadata with Gantry events and durable messages.
6. The actor removes test-created messages where permitted, and Vitest records
   cleanup separately.

Telegram uses the same flow with a dedicated chat/topic and Telegram update and
message IDs.

## Determinism and model judgment

Assertions use this order:

1. HTTP status and schema.
2. Stable relationships and state transitions.
3. Runtime/audit events and durable database state.
4. Recorded tool name and structured arguments.
5. Provider delivery ID and correct destination/thread/topic.
6. A bounded semantic judge only if the first five cannot prove the outcome.

The judge receives only the task, a short redacted response, and an explicit
rubric. It must return structured `pass`, `fail`, or `uncertain` plus one result
per criterion. Invalid output may be retried once. `uncertain` is not a pass,
and a judge can never override a deterministic failure. No voting system or
general-purpose grading framework is needed.

The subject model and judge model use separate catalog aliases and credentials.
The first judge candidate is the existing inexpensive `gpt-mini` alias, but no
judge is added until a concrete scenario proves structured assertions are
insufficient.

## Isolation, credentials, and cleanup

- Reuse the harness isolation guard: fresh temporary `GANTRY_HOME`, new database
  per run, generated API keys, pinned locale/time zone, and model credentials
  removed from deterministic lanes.
- Live lanes use dedicated test apps, workspaces, users, bots, conversations,
  and channels. Production resources are forbidden.
- Each external provider runs with concurrency `1` to avoid message races.
- Secrets come only from the protected CI environment and never enter fixtures,
  logs, snapshots, or uploaded evidence.
- Each live scenario writes a unique correlation token, targets a dedicated
  conversation, and deletes test-created provider artifacts where the provider
  permits it.
- Cleanup failure is reported separately from product failure and retains the
  resource IDs needed for manual cleanup.

## Result and evidence semantics

- **PASS** — every required deterministic invariant and delivery check passed.
- **FAIL** — Gantry accepted the scenario but violated a required invariant.
- **SKIPPED** — the lane was intentionally unavailable, such as an untrusted fork
  with no protected environment. A skip is never presented as live coverage.
- **CONFIGURATION ERROR** — a protected scheduled/manual lane was expected to
  run but its actor, credential, or destination was missing or invalid.

The existing evidence writer remains the common artifact path. Live scenarios
add provider message/delivery identifiers, never token values or unredacted
message history.

## CI topology

1. Pull requests run the existing unit and integration suites.
2. Nightly hermetic E2E builds the packaged runtime and runs credential-free
   scenarios against disposable Postgres.
3. Protected model E2E runs separately so provider failure is distinguishable
   from hermetic failure.
4. Slack, Telegram, and later provider lanes are separate jobs/workflows with
   provider-specific secrets, timeouts, evidence, and concurrency groups.
5. Permission prompts and other state-changing live cases are manual or
   label-gated until their cleanup and isolation are proven.
6. Slack workflow alerts are a later delivery concern; test correctness and CI
   result semantics come first.

## Capability portfolio

The detailed status remains in the matrix. The intended portfolio covers:

- runtime boot, migration, restart, and recovery;
- onboarding, sessions, model selection, controls, usage, and errors;
- identity resolution, aliases, merge/unmerge, isolation, and acting identity;
- personal/shared memory and cross-turn continuity;
- permission request, approval, denial, expiry, and grant isolation;
- skills, MCP servers, tool discovery, arguments, and audit evidence;
- jobs, delegation, cancellation, recovery, and delivery;
- attachments, egress, and destination routing;
- API/App, Slack, Telegram, Discord, and eventually Teams journeys;
- credential redaction, scope enforcement, and recovery behavior.

We prove the canonical journey once through API/App, then add one thin scenario
per messenger for provider-specific ingress, threading/topic routing,
interaction rendering, and delivery. Business logic is not duplicated for
every channel.

## First detailed journey: identity lifecycle

This is the smallest next packaged-runtime scenario because its public Control
API exists and the result is deterministic.

1. Resolve a new provider alias with create permission.
2. Resolve it again and assert the same `personId` without a duplicate person.
3. Verify a resolve-only key cannot create and cannot see alias detail without
   `people:read` or `people:admin`.
4. Create a second person with a different provider alias.
5. Add person-scoped memory through the public memory API for both people.
6. Preview a merge; assert the fingerprint is returned and no person, alias, or
   memory state changed.
7. Apply the merge with that fingerprint; assert aliases and personal memory
   now belong to the target and the merge event is observable.
8. Resolve the source alias; assert it reaches the target person.
9. Unmerge using the recorded audit ID/fingerprint; assert the archived person
   and merge-owned data are restored and the unmerge event is observable.
10. Assert another app cannot list, resolve, or mutate these identities.

Follow-up identity scenarios cover retired aliases, DM person-scoped grants,
group/shared scope, and cross-channel alias convergence. They should reuse the
same API client and lifecycle fixture rather than repeat the full journey.

## Live channel contracts

### Slack

A controlled test user posts a correlation-tagged message in a dedicated test
channel/thread. Gantry must ingest it under the intended Provider Account and
Conversation Install, create one session/run, and deliver one bot reply to the
same thread. The test correlates provider delivery with Control API events and
durable messages. Later cases add one permission button callback and one small
attachment.

### Telegram

A controlled test user posts in a dedicated private chat or test group topic.
Gantry must create one session/run and reply to the same chat/topic. The test
correlates the Telegram update/message IDs with Control API evidence. Later
cases add one callback button and one small attachment.

### Discord and Teams

Discord follows after Slack and Telegram using the same thin provider contract.
Teams live E2E remains deferred until the repository contains a complete live
Bot Framework transport; adapter scaffolding alone is not a testable user
journey.

## Implementation waves

| Wave | Deliverable                                               | Exit condition                                                                          |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0    | This architecture and reconciled matrix                   | Scope, lanes, ownership, and open live-actor decisions are explicit                     |
| 1    | Explicit managed target + packaged identity lifecycle E2E | Public multi-step journey passes locally with disposable Postgres and redacted evidence |
| 2    | Turn failure and inline LLM API E2E                       | Bad model terminates cleanly; one protected inline real-model request records usage     |
| 3    | One composed memory/permission and one skill/MCP journey  | Structured state/tool evidence passes without prose snapshots                           |
| 4    | Slack protected E2E                                       | Dedicated actor drives inbound-to-threaded-delivery proof in CI                         |
| 5    | Telegram protected E2E                                    | Dedicated actor drives inbound-to-chat/topic-delivery proof in CI                       |
| 6    | Discord protected E2E; Teams only after transport         | Same thin contract passes without duplicating business scenarios                        |

Each wave is planned, implemented, run locally where credentials allow, and
then added to its CI lane. A wave does not claim live verification when its
protected actor or credential is unavailable locally.

## Acceptance criteria

- Every scenario maps to one user outcome and one matrix row.
- Public APIs/providers are used wherever available; no test-only endpoint is
  introduced.
- Deterministic assertions decide all outcomes they can.
- Tests have isolation, cleanup, time budgets, and redacted evidence.
- PR checks remain credential-free and reasonably short.
- Live provider failures are reported separately and never make a skipped lane
  look green.
- New runtime behavior is accompanied by the appropriate integration/E2E delta.

## Surface impact matrix

| Surface                      | Design-phase impact   | Future implementation rule                                                                |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| Runtime and packaged process | observed              | Reuse `runtime-harness.ts`; change runtime only for a proven product bug                  |
| Settings and model catalog   | observed              | Configure through public desired-state APIs and aliases                                   |
| Postgres                     | observed              | Disposable database only; assert durable behavior through APIs/events first               |
| Control API                  | observed              | Primary deterministic driver; no test-only routes                                         |
| SDK/contracts                | observed              | Reuse existing contracts/client; add helpers only when repeated public steps justify them |
| CLI and MCP admin            | unchanged             | Test only when the user journey specifically starts there                                 |
| Channel adapters             | observed              | Thin provider-specific scenarios; fix adapters only for proven failures                   |
| Audit/runtime events         | observed              | Stable correlation evidence, not wording snapshots                                        |
| Documentation                | changed               | This design owns architecture; the existing matrix owns coverage status                   |
| CI                           | deferred to each wave | Separate hermetic, model, and provider results                                            |

## Locked decisions

- One existing Vitest E2E framework and harness.
- API-first, multi-step scenarios with behavioral assertions.
- Vitest owns orchestration and pass/fail; MCP-backed actors or supervisor agents
  only perform and observe external user actions.
- Deterministic checks before any LLM judgment.
- Isolated dummy-data lanes are distinct from protected real-provider lanes.
- Identity lifecycle is the first new packaged-runtime scenario.
- Slack and Telegram are the first live messengers; Discord follows; Teams waits
  for a complete live transport.
- Slack alerting is not part of the first test implementation wave.

## Decisions required before live implementation

These cannot be inferred safely from repository code:

1. **Slack actor:** approve a dedicated Slack test workspace and controlled test
   user OAuth credential. Bot/app tokens alone do not represent a user sending
   the inbound message.
2. **Telegram actor:** approve a dedicated Telegram test account and an MTProto
   client credential/driver. A bot cannot reliably impersonate the user side of
   this E2E journey.
3. **Judge provider:** approve `gpt-mini` plus its protected credential only when
   the first concrete semantic rubric is needed.
4. **Schedule:** choose whether protected messenger lanes run nightly or only on
   manual/label-gated triggers while they are being stabilized.
5. **Actor transport:** select and approve the actual Slack and Telegram MCP
   servers or deterministic provider clients available in protected CI; the
   repository does not currently provide these external actor drivers.
