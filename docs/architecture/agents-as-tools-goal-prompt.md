# Agents-as-Tools — Goal Prompt (v3, post grilling)

Approved as the PRIMARY orchestration mechanism (platform-roadmap-2026-07.md):
registered agents projected as callable tools; main agent = orchestrator,
specialists = configured subagents. Static persona-as-tool, not agent-to-agent
free chat.

## User decisions (grilling, 2026-07-17) — BINDING

1. **Result flow = HYBRID.** A synthetic agent-tool call blocks up to a timeout
   and returns the specialist's result inline; if the run exceeds the timeout it
   falls back to a queued async task id the orchestrator can check later.
2. **Callable set = CURATED per-orchestrator allowlist.** Each orchestrator is
   explicitly configured with which specialists it may call (NOT all app agents).
3. **Topology = DEPTH-1 STAR.** Only the orchestrator delegates; a called
   specialist gets no agent-tools.
4. **Visibility = NARRATED.** The orchestrator posts a short line to the
   originating conversation when it delegates ("Checking with the <name>…") and
   when the result returns. Not the full sub-agent transcript.

## What is / isn't plumbed

Already: `delegate_task` carries `targetAgentId`; the `!sameAgent` path resolves
the callee's OWN posture (`inline-agent-task-lifecycle.ts:124` `resolveRunAccess`,
`:187` `buildRunOptions`; IPC `ipc-agent-delegation-target.ts:80`); child prompts
route to the origin conversation via inherited `chatJid`; a delegated run
produces a result (`inline-agent-task-lifecycle.ts` streams progress + returns
`output.result`). The async posture-resolution seam is the inline wiring layer
`inline-agent-loop-tools.ts` (already awaits `resolveTurn*` from
`group-run-context.ts`) — compute the manifest there, pass precomputed into the
sync `createInlineCoreTools` (do NOT make the tool builder async).

NOT plumbed (the real work): (a) a per-orchestrator delegates allowlist +
its config surface; (b) dynamic per-agent tool registration across lanes; (c) a
HYBRID sync-with-timeout dispatch over the async backend; (d) handler-driven
narration; (e) parent trace-context propagation. `approvalContextJid` is NOT
plumbed through `AgentInput`/permission IPC — DEFER (v1 pins the existing
`chatJid`/`targetJid` origin-routing invariant).

## Scope (v1)

### 1. Curated allowlist + config surface

- Each agent config gains a `delegates` list (immutable agent ids/folders this
  agent may call). Store it settings-owned alongside the agent's skills/MCP
  bindings — DETERMINE the exact seam (register_agent binding vs agent profile
  vs settings agent config) and pin it; it must round-trip through the settings
  desired-state export/revision like other agent config. If setting it needs a
  new tool/API surface, keep v1 to the config field + a minimal setter
  (agent_profile_update extension) and note richer UX as later.
- The manifest builder resolves the CALLER's `delegates` entries → active,
  same-app, non-self agents only. Empty allowlist ⇒ no synthetic tools.

### 2. Host-authoritative manifest + cross-lane projection

- Pure `projectCallableAgentTools(caller) -> {toolName, targetAgentId,
displayName}[]`: from the caller's `delegates` allowlist, filter active +
  same-app + non-self; `toolName` from IMMUTABLE identity (collision-safe,
  length-bounded — NOT display name, which is non-unique); display name only in
  the one-line description. Returns EMPTY when `parentTaskId` is set (depth
  suppression) or `AgentDelegation` not held.
- Project into EVERY tool lane (not one call-site), each gated like
  `delegate_task` (AgentDelegation + executor availability +
  `excludeAuthorityTools===false`): inline core-tool registry
  (`inline-agent-loop-tools.ts` wiring → sync builder), Anthropic allow-list/env
  (`agent-capabilities.ts`), DeepAgents Gantry MCP (`gantry-mcp-tool-surface.ts`),
  dynamic stdio MCP registration. Under locked/no-permission projection the
  synthetic tools disappear. Audit/rules/prompts canonicalize to `AgentDelegation`.

### 3. Hybrid dispatch (sync-with-timeout → async fallback)

- Each synthetic handler is a thin adapter over the existing delegation backend
  (`task-lifecycle.ts` `startDelegatedAgent`, UNCHANGED spawn), schema OMITS
  `targetAgentId`; the adapter injects the manifest's FIXED target and
  revalidates same-app + active + non-self + IN the caller's allowlist.
- After starting the delegated run, AWAIT its result up to a timeout (the tool's
  `timeoutMs`, default e.g. 60s). Completed in time ⇒ return the specialist's
  result inline. Exceeded ⇒ return the queued task id + a "still running" marker
  (async fallback) so the orchestrator can retrieve it later via the existing
  task lifecycle. DETERMINE whether a blocking-await-with-timeout over the
  delegated run already exists or must be added at the lifecycle seam; keep it to
  the smallest correct mechanism (no polling loops if an await/notify exists).

### 4. Narration (handler-driven, deterministic)

- On delegate start, the handler posts a short line to the ORIGINATING
  conversation ("Checking with the <displayName>…") via the existing
  send_message/conversation delivery to `owner.conversationId`. On sync result,
  post a brief completion line (or let the orchestrator incorporate the returned
  result — post at least a "…done" marker). Do NOT post the sub-agent transcript.
  Narration is emitted by the handler, not dependent on the LLM choosing to narrate.

### 5. Depth-1 star — enforced in projection + host

- Projection returns nothing when `parentTaskId` is set (synthetic tools never
  appear inside a delegated child). Host enforcement (IPC `parentTaskId`
  rejection + inline `runDelegatedAgent` absence) stays as defense in depth.
  `maxDepth:1` is metadata. No counted-depth.

### 6. Per-hop trace nesting (ledger C.8)

- `startTurnSpan` (`tracing.ts:207`) gains an optional parent span-context param;
  open the child span under it; carry `parentRunId` to the child. Fail-open.

## Out of scope

Counted-depth chains; role concepts; app-wide/flat callable set; explicit
`approvalContextJid` propagation; shared-conversation multi-agent; blueprints.

## Surface Impact Matrix

| Surface                     | Classification     | Reason                                                                    |
| --------------------------- | ------------------ | ------------------------------------------------------------------------- |
| Runtime behavior            | Changed            | Synthetic per-agent tools; hybrid dispatch; narration; depth suppression  |
| settings.yaml               | Changed            | New per-agent `delegates` allowlist (desired-state + revision round-trip) |
| Postgres/runtime projection | Read-only          | Reads active agent inventory + allowlist                                  |
| Control API                 | Possibly changed   | Minimal setter for `delegates` (agent profile extension) — confirm        |
| SDK/contracts               | Changed (internal) | Manifest + tool schemas + allowlist field                                 |
| CLI                         | Possibly changed   | If `delegates` is CLI-settable — confirm minimal                          |
| Channel/provider adapters   | Changed            | Narration posts to originating conversation                               |
| Gantry MCP tools            | Changed            | Cross-lane synthetic-tool projection                                      |
| Docs/prompts                | Changed            | This goal-prompt + ledger                                                 |
| Audit/events                | Changed            | Synthetic tools canonicalize to AgentDelegation                           |
| Tests/verification          | Changed            | Allowlist, projection, hybrid dispatch, narration, depth, trace           |

## Verification

- Unit: allowlist round-trips through settings export/revision; manifest = caller's
  allowlist ∩ active/same-app/non-self; collision-safe naming; projection present
  in all lanes when eligible, ABSENT for a `parentTaskId` child + locked mode +
  empty allowlist; synthetic tool injects the fixed target + rejects override;
  hybrid dispatch returns inline result within timeout and falls back to task id
  past it; narration posts start + completion to the origin conversation; callee
  posture isolation (no escalation, own memory scope); child span nests under
  parent.
- `tsc --noEmit`, focused suites (runtime/application/runner/channels/config/
  observability), settings parser/renderer/revision tests, arch gate.
- Ponytail: one manifest builder; thin dispatch adapters; reuse the delegation
  backend + existing projection lanes + send_message; smallest hybrid mechanism;
  no counted-depth.

## Stages (each green; bounded write scope)

1. **Allowlist config surface** — `delegates` field on agent config +
   settings parser/renderer/revision round-trip + minimal setter + tests.
2. **Manifest + inline-lane projection + pinned-target dispatch (async result for
   now) + depth suppression** — tests.
3. **Hybrid sync-with-timeout dispatch + async fallback** — tests.
4. **Narration (start + completion to origin conversation)** — tests.
5. **Remaining projection lanes (Anthropic, DeepAgents, stdio MCP) + locked-mode
   suppression + audit canonicalization** — tests.
6. **Trace nesting (parent-context propagation)** — tests.

---

# v4 corrections (post re-validation) — BINDING seams

## A. Allowlist seam (Stage 1) — pinned

- Add `delegates: string[]` (immutable agent folders/ids) to the settings agent
  config `agents.<folder>` — NOT agent_profile_update (that writes profile
  artifacts, not desired settings). Set via the EXISTING desired-state replace
  path (`request_settings_update` `runner/mcp/tools/settings.ts:110-145` / control
  route `control/server/routes/settings.ts:87-118` → canonical import + revision
  append + projection + YAML sync at `jobs/ipc-runtime-admin-handlers.ts:351-431`).
  No new narrow setter.
- Full fan-out (all required): types `runtime-settings-types.ts:158-178,200-220`;
  public contract `packages/contracts/src/settings/index.ts:117-150`; parser
  `runtime-settings-agents-parser.ts:171-237,351-402`; renderer
  `runtime-settings-renderer.ts:206-360`; revision serialize/parse
  `settings-import-service.ts:343-405,455-541`; BOTH export constructors
  `desired-state-current-export.ts:251-288,539-582` (+ helpers
  `desired-state-export-helpers.ts:34-68`); DB projection/reconcile
  `desired-state-capability-reconcile.ts:43-107,302-339`; defaults
  `runtime-settings.ts:125-151` + `config/index.ts:128-150`.
- **BUMP `CURRENT_SETTINGS_READER_VERSION` 13→14** (`settings-import-service.ts:
31-37`; update the pin test `settings-import-service.test.ts:655-668`). Revision
  doc must serialize `delegates` (`settings-import-service.ts:455-492`). Add
  parser/renderer/revision round-trip tests.

## B. Hybrid dispatch (Stage 3) — the BLOCKER, build carefully

- **Separate `syncWaitTimeoutMs`** distinct from the delegated run's execution
  `timeoutMs` (`task-lifecycle.ts:169-175`), which KILLS the child at expiry
  (`agent-spawn-process.ts:180-201`, `agent-inline.ts:370-389`). The sync wait
  must NOT kill the run — on wait-budget expiry the durable task keeps running and
  the handler returns the queued task id (async fallback). Preserve the execution
  timeout independently.
- **Build a per-task completion subscription/deferred** on the task-lifecycle
  service carrying the UNTRUNCATED result (persisted output is capped at 1000
  chars — `async-command-task-helpers.ts:16,123-125` — so polling the DTO is
  insufficient). Reuse the terminal-notification path
  (`async-delegated-agent-task.ts:431-471`) + change-waiter
  (`async-task-change-waiter.ts:3-47`) but surface the full result to the awaiter.
- **DETACH the hybrid handler** from the serialized IPC path: add delegation to the
  detached long-running task types (`runtime/ipc-long-running-task.ts:8-27`) and
  set its IPC response deadline ABOVE the sync-wait budget (worker task IPC
  currently times out at 20s — `runner/mcp/tools/task-lifecycle.ts:21`). Otherwise
  a parent awaiting inline while the callee makes a response-requiring IPC call
  self-deadlocks on the serialized watcher (`ipc.ts:157-213,359-396`).
- **Mind group-queue starvation**: the parent holds its run slot until the turn
  returns (`group-queue.ts:506-549`), global message-run limit default 3
  (`group-queue-policy.ts:1-4,25-38`). Concurrent sync-delegations can starve;
  document the ceiling + keep the sync wait bounded. MUST-TEST: callee invokes a
  response-requiring IPC tool while the parent is in its sync wait — no deadlock.

## C. Narration (Stage 4) — routing + fail-open

- Use `sendCoreMessage` (`application/core-tools/send-message.ts:24-70`) via the
  injected `ChannelWiring.sendMessage` (`inline-agent-loop-tools.ts:609-615`), but
  route with `owner.conversationId` + `owner.providerAccountId` + `owner.threadId`
  (all in task ownership `task-lifecycle.ts:32-38`) — conversationId alone
  under-resolves when >1 provider route matches
  (`channel-wiring-route-provider-account.ts:20-34`).
- **FAIL-OPEN**: narration must not throw if delivery is unavailable (the inline
  injection currently throws). Wrap + swallow-with-warn. Define ordering: narration
  may interleave with buffered/streamed output (`group-output-buffer.ts:48-118`,
  `agent-output-callbacks.ts:34-52`) — post the "delegating" line before the sync
  wait and the completion line after; accept best-effort ordering.

## Per-stage file scopes + serialization

Stages 2–5 SHARE `application/core-tools/task-lifecycle.ts:154-183` + the IPC
seams, so they SERIALIZE (one at a time, not parallel). Each stage's Codex
dispatch gets an explicit file allowlist. Stage 1 (settings) is disjoint from the
handler seams and can run first independently.

## Stage 1 implementation ledger

- Scope: implemented Stage 1 only. Projection, dispatch, hybrid waiting,
  narration, and trace propagation remain deferred and untouched.
- Contract: `agents.<folder>.delegates` is a required runtime/public `string[]`.
  The parser defaults an absent field to `[]`, rejects non-string and empty
  entries, and preserves unresolved or dangling agent-folder references. The
  renderer omits the field when it is absent or empty.
- Mutation path: writes use the existing desired-state replace path. No narrow
  setter or `agent_profile_update` extension was added.
- Revision contract: revision documents serialize non-empty `delegates`; empty
  lists remain omitted. `CURRENT_SETTINGS_READER_VERSION` is `14`.
- Projection choice: no DB table or column was added, and
  `desired-state-capability-reconcile.ts` plus
  `desired-state-export-helpers.ts` needed no changes. The authoritative settings
  revision/YAML owns `delegates`; both current-export constructors preserve or
  reconstruct the configured list, while DB reconciliation remains scoped to
  the existing source/capability projection.
- Verification: TypeScript completed with exit 0; config unit tests passed 21
  files / 304 tests; the architecture gate reported only the accepted
  `text-styles.ts` Telegram findings at lines 13, 64, and 75 after renderer
  extraction reduced the file to 719 lines (budget 721).

## Stage 2 implementation ledger

- Scope: implemented the callable-agent manifest, inline-lane projection,
  pinned-target async dispatch, and depth suppression only. Hybrid waiting,
  narration, remaining projection lanes, and trace nesting remain deferred to
  Stages 3-6.
- Manifest contract: the caller's settings-owned `delegates` list resolves
  against the current app's agent inventory and projects active, same-app,
  non-self targets only when exact `AgentDelegation` authority is held. A
  delegated child (`parentTaskId`) projects no callable-agent tools.
- Naming contract: synthetic names use `delegate_to_` plus a length-bounded
  suffix derived only from immutable agent identity. Display names are used
  only in one-line descriptions and cannot select or collide targets.
- Inline contract: agent inventory is loaded in the async inline preload seam
  and the resulting manifest is passed as plain data into the synchronous core
  tool registry. Locked/authority-hidden runs, empty allowlists, and runs
  without the delegated-task executor project no synthetic tools.
- Dispatch contract: each synthetic schema omits `targetAgentId`; the adapter
  injects the manifest's fixed target, rejects override attempts, and
  revalidates current same-app, active, non-self, allowlisted eligibility before
  calling the unchanged `delegate_task` backend. Stage 2 returns the existing
  queued task DTO.
- Authority contract: synthetic prompts, declarative rules, success accounting,
  and inline tool-activity audit use canonical `AgentDelegation`.
- Verification: TypeScript completed with exit 0; focused Stage 2 tests passed 3
  files / 54 tests; the requested runtime/application/runner/bootstrap unit run
  passed 171 files / 2,325 tests; the architecture gate reported only the
  accepted `text-styles.ts` Telegram findings at lines 13, 64, and 75.
- Verification: TypeScript completed with exit 0; the focused Stage 2 tests
  passed 3 files / 54 tests; the requested broad unit command passed 171 files /
  2,325 tests; the architecture gate reported only the accepted
  `text-styles.ts` Telegram findings at lines 13, 64, and 75.
- Autoreview follow-up: callable-agent manifest preloading now applies every
  run-level suppression gate (tools disabled, authority hidden, locked access,
  delegated child, missing `AgentDelegation` authority, and missing task
  lifecycle executor) before consulting agent inventory. Suppressed runs do not
  call `listAgents`, so repository failures cannot affect them.

## Stage 3 implementation ledger

- Scope: upgraded only the Stage 2 synthetic callable-agent dispatch to bounded
  hybrid waiting. Narration, other execution lanes, and trace nesting remain
  deferred to Stages 4-6.
- Timeout contract: callable-agent dispatch now carries a distinct
  `syncWaitTimeoutMs`, defaulting to and capped at 60 seconds. The delegated
  run's independent `timeoutMs` still controls execution/abort. Exhausting the
  sync-wait budget returns the queued task id without cancelling the durable
  child.
- Completion contract: a completion subscription is registered before queue
  admission can drain the task. Terminal settlement resolves it with the full
  in-memory result; the existing persisted 1,000-character output cap remains
  unchanged for async DTOs.
- IPC contract: `delegate_task` is classified as detached long-running IPC, and
  its response deadline is 65 seconds, above the 60-second sync-wait ceiling.
  Ordinary task IPC retains its 20-second response deadline. A real watcher
  test holds delegation open while a response-bearing `task_get` completes,
  pinning the no-serialization-deadlock guarantee.
- Queue ceiling: a waiting parent still occupies one message-run slot. With the
  default global limit of three, hybrid waits can temporarily consume one of
  those three slots, but never for more than the 60-second sync-wait cap; queue
  policy and child execution timeout are otherwise unchanged.
- Deterministic coverage: inline full-result completion, async fallback with the
  child still running and later retrievable, response-bearing IPC during the
  parent wait, and untruncated results above 1,000 characters.
- Verification: TypeScript completed with exit 0; the focused hybrid suite
  passed 4 files / 69 tests; the requested broad unit command passed 185 files
  / 2,436 tests; the architecture gate reported only the accepted
  `text-styles.ts` Telegram findings at lines 13, 64, and 75.
- Decisions and assumptions: no product or security decisions were introduced;
  all three plan-validation seams were implemented as pinned.

## Stage 4 implementation ledger

- Scope: implemented handler-driven narration for the existing inline
  synthetic callable-agent tools only. Remaining projection lanes and trace
  nesting remain deferred to Stages 5-6.
- Handler contract: after initial eligibility revalidation, the synthetic
  handler attempts `Checking with the <displayName> agent…` for up to five
  seconds, then revalidates eligibility immediately before entering the hybrid
  delegation wait. A synchronous terminal result sends
  `<displayName> responded.`; an expired sync-wait budget sends
  `<displayName> is still working; I'll follow up.` No child transcript is
  delivered.
- Routing contract: narration reuses `sendCoreMessage` through the injected
  `ChannelWiring.sendMessage` dependency and carries the originating
  conversation id, provider account id, and thread id.
- Failure contract: narration delivery errors are swallowed with a warning.
  They cannot prevent delegation, cancel the child, or replace the delegated
  result. Calls rejected before delegation emit no narration.
- Ordering contract: the start line is attempted before delegation with
  best-effort ordering (bounded to five seconds); the result/fallback line
  follows the handler result, with best-effort ordering relative to buffered or
  streamed agent output.
- Autoreview follow-up: result narration now keys on the Stage 3 lifecycle
  `data.status`: only `completed` posts the responded line, while `queued` or
  `running` posts the follow-up line even when the payload also has a `taskId`.
  Missing or unexpected statuses remain fail-open without a false outcome line.
- Verification: TypeScript completed with exit 0; the focused narration suite
  passed 1 file / 10 tests; the requested broad unit command passed 153 files /
  2,409 tests; the architecture gate reported only the accepted
  `text-styles.ts` Telegram findings at lines 13, 64, and 75.
- Decisions and assumptions: none. Stages 5 and 6 remain unchanged by design.
- Authorization follow-up: callable-agent dispatch now revalidates current
  eligibility after the bounded-awaited start narration and immediately before
  delegation. A target revoked during narration is not invoked, returns
  `forbidden`, and receives a best-effort no-longer-available correction in the
  origin route.
- Authorization follow-up verification: the focused callable-agent suite passed
  1 file / 11 tests; TypeScript exited 0; the requested broad unit command
  passed 153 files / 2,410 tests; the architecture gate reported only the
  accepted `text-styles.ts` findings at lines 13, 64, and 75.

## Stage 5 implementation ledger

- Scope: projected the Stage 2 callable-agent manifest into the Anthropic,
  DeepAgents, and stdio MCP lanes. Stage 6 trace nesting remains deferred.
- Projection contract: worker preload uses the existing manifest builder once;
  each lane receives that plain-data manifest and reuses the same callable-agent
  name, schema, and definition construction. No lane derives its own target set.
- Suppression contract: preload and every lane suppress synthetic tools for a
  delegated child, locked/authority-hidden access, unavailable async task
  lifecycle, or an empty delegate allowlist. Suppressed preload does not read
  agent inventory.
- Dispatch contract: stdio registration injects the manifest-pinned target and
  carries the Stage 3 default bounded sync wait. The host revalidates current
  active, same-app, non-self allowlist eligibility before delegation.
- Audit contract: synthetic IPC carries its synthetic tool identity only for
  revalidation, then records durable delegated-task authority as
  `AgentDelegation`. Anthropic permission naming and DeepAgents heartbeat events
  use the same canonical name; ordinary `delegate_task` audit remains unchanged.
- Autoreview follow-up: stdio manifest parsing accepts the full base64url
  alphabet emitted by the shared builder, and the cross-lane test consumes a
  real projected manifest. Synthetic stdio dispatch also enters the shared
  Stage 4 narration path and revalidates eligibility after start narration.
- Timeout/name follow-up: stdio IPC uses a 75-second response budget, leaving
  setup margin beyond narration and the bounded sync wait. DeepAgents applies an
  80-second MCP timeout only to manifest-listed synthetic tools, leaving existing
  question, browser, and scheduler tool budgets unchanged. The
  manifest builder bounds display names once, while stdio skips an invalid entry
  without hiding valid sibling tools.
- Scheduled-run follow-up: inline and worker synthetic dispatch carry the
  existing scheduled-job flag into shared narration, so intermediate delegation
  messages remain suppressed and the scheduler owns terminal notification.
- Verification: TypeScript completed with exit 0; focused Stage 5 coverage
  passed 7 files / 85 tests plus the final regression set at 5 files / 58
  tests; the requested broad unit command passed 157 files / 2,446 tests. The
  architecture gate reported 0 non-text-style findings and only the accepted
  `text-styles.ts` Telegram findings at lines 13, 64, and 75.
- Decisions and assumptions: none. Locked-mode suppression is defense in depth
  at host preload, lane projection, stdio manifest parsing, and the existing
  locked IPC denial boundary.

## Stage 6 implementation ledger

- Scope: implemented per-hop trace nesting for callable-agent delegation only.
  Counted depth and all other runtime, configuration, persistence, API, CLI,
  MCP inventory, channel/provider, and audit behavior remain unchanged.
- Trace contract: `startTurnSpan` accepts an optional OTel parent context and
  records `gantry.parent_run_id` when the child carries a parent run id. A live
  parent produces the same trace with the child turn span nested directly under
  the delegating turn span.
- Propagation contract: inline and worker lanes capture the host-owned turn
  correlation id before delegation. Non-job tasks persist it as `parentRunId`
  for child spawn and recovery; scheduled tasks keep the existing null durable
  parent for job/FK semantics, while their live child receives the host-only
  correlation directly. The spawn turn tracker resolves the child input through
  the existing in-process turn-span registry and OTel child-context helper.
- Failure contract: tracing disabled remains a no-op. A missing host correlation
  id or registry miss starts the child as a root turn span; runner input cannot
  supply or override the trusted trace link. Recovered scheduled delegations
  remain roots because they intentionally persist no parent turn. Tracing
  failures remain isolated from delegation and spawn.
- Verification: TypeScript completed with exit 0; focused trace/propagation
  coverage passed 3 files / 37 tests; the requested broad unit command passed
  129 files / 1,791 tests. The architecture gate reported 0 non-text-style
  findings and only the accepted `text-styles.ts` findings at lines 13, 64, and 75.
- Decisions and assumptions: none. This remains v1 per-hop nesting; no parallel
  trace registry or counted-depth mechanism was added.

## Stage 7 — Durable async follow-up and coherent result bounds

Goal: complete callable-agent fallback delivery without adding persistence
surfaces, and keep delegated output useful without allowing an unbounded child
result into the caller's model context.

### Scope

- When a callable `AgentDelegation` task exhausts its synchronous wait, persist
  that fallback decision in the existing async-task JSON state before returning
  `Queued`.
- After any such task reaches a terminal state, enqueue one deterministic
  inbound message plus live-admission work item for the caller agent's original
  conversation and thread through `storeMessageWithLiveAdmission`.
- Retry a pending terminal follow-up from the existing async-task recovery pass.
  The deterministic task-derived message identity makes crash retries
  idempotent.
- Do not arm follow-up delivery for a task that completed during the synchronous
  wait, ordinary `delegate_task` calls, non-delegated async tasks, or
  scheduler-owned delegation.
- Persist the full delegated result for `task_get`. Bound inline and follow-up
  model-context delivery to 4,000 characters and direct truncated consumers to
  `task_get <taskId>`. Keep receipt and task-list summaries bounded previews.

### Durable identity clarification

The delegated task row does not contain `parentTaskId`; Gantry passes that row's
task id to the spawned child as its parent task id. Callable tasks are therefore
identified durably by `kind = delegated_agent`, authority tool
`AgentDelegation`, and the persisted async-fallback marker. Stage 7 does not add
a self-referential parent id.

### Verification

- Add focused unit coverage for a terminal async fallback with no in-memory
  waiter, restart recovery of a pending follow-up, no sync-path double delivery,
  capped inline output, and lossless `task_get` retrieval beyond 1,000
  characters.
- Run only the touched Vitest unit files plus `npm run typecheck`.

### Surface Impact Matrix

| Surface                     | Classification       | Reason                                                                                       |
| --------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Callable async fallback gains one durable follow-up; context delivery is capped.             |
| `settings.yaml`             | Unchanged by design  | Delivery and result bounds are internal invariants.                                          |
| Postgres/runtime projection | Changed              | Existing async-task JSON and canonical message/live-admission rows are reused; no migration. |
| Control API                 | Unchanged by design  | No new operation or payload.                                                                 |
| SDK/contracts               | Unchanged by design  | Public tool schemas and task DTOs remain stable.                                             |
| CLI                         | Unchanged by design  | Existing `task_get` is reused.                                                               |
| Gantry MCP/admin            | Read-only/observable | Existing `task_get` exposes the lossless result.                                             |
| Channel/provider adapters   | Unchanged by design  | Follow-up enters the channel-neutral live-turn queue.                                        |
| Docs/prompts                | Changed              | This completion contract and its assumptions are recorded here.                              |
| Audit/events                | Unchanged by design  | Existing persisted message/admission evidence is sufficient.                                 |
| Tests/verification          | Changed              | Focused regression coverage and typecheck are required.                                      |

### Stage 7 implementation ledger

- Durable completion contract: the timeout boundary CAS-persistently marks a
  callable task for follow-up. Every delegated terminal write now passes
  through the service-owned settlement hook, which resolves any live waiter and
  attempts the deterministic message/live-admission enqueue. Terminal pending
  markers are retried by normal async-task recovery after restart.
- Routing contract: the follow-up uses the caller task's app, agent,
  conversation, provider account, and thread. Its trusted admission decision
  bypasses a conversation mention requirement without changing ordinary
  channel ingress policy.
- Result contract: terminal delegated output is stored in full; task lists and
  receipts remain 1,000-character previews. Inline and follow-up context text
  share a 4,000-character cap with a task-id-specific `task_get` instruction.
- Verification: `npm run typecheck` exited 0. The focused unit command passed 3
  files / 95 tests. No full suite, autoreview, commit, branch change, or runtime
  restart was performed.
- Decisions and assumptions: none. No schema, settings, Control API, CLI,
  provider adapter, or new durable projection was added.

## Stage 8 — Audited callable-agent UX and control surface

Goal: close the confirmed callable-agent quality gaps without changing the
delegation topology, authority model, hybrid lifecycle, or trace contract.

### Scope and acceptance criteria

1. Callable-agent manifest entries carry the target's settings-owned persona,
   and every synthetic tool description includes the concise display name and
   persona.
2. Start narration includes a redacted, length-bounded objective snippet.
   Failure narration includes a redacted, length-bounded failure reason.
3. Per-turn projection intersects the curated allowlist with agents bound to
   the caller's current conversation route, so an unbound delegate is not
   offered as a synthetic tool.
4. A terminal delegated `failed` completion maps to a non-retryable business
   error, while `timed_out` remains transient/retryable.
5. Each unresolved configured delegate ref emits one bounded operator warning
   per projection, naming the owning agent and unresolved ref.
6. `GET /v1/agents/{agentId}/delegates` returns the configured refs plus the
   active callable roster (including persona), and
   `PUT /v1/agents/{agentId}/delegates` replaces the list after validating refs
   against same-app registered agents. The mutation uses the existing canonical
   desired-state control writer/revision path; it never writes `settings.yaml`
   directly or adds a second persistence path.

### Bounded implementation packets

- Manifest/projection/narration: shared callable manifest, application
  projector/dispatcher, inline and worker preload seams, IPC revalidation, and
  their focused tests.
- Completion classification: task-lifecycle error mapping plus the existing
  core-tools mapping table test.
- Control surface: agent contracts, agents route, shared desired-state control
  writer, OpenAPI route/schema registration, and focused control/OpenAPI tests.

### Surface Impact Matrix

| Surface                     | Classification       | Reason                                                                                  |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| Runtime behavior            | Changed              | Persona-aware descriptions, richer narration, bound-only projection, and error typing.  |
| `settings.yaml`             | Changed              | Delegate API replacement syncs the existing `delegates` field through canonical write.  |
| Postgres/runtime projection | Changed              | Reads bindings for projection/API and appends normal settings revisions on replacement. |
| Control API                 | Changed              | Adds first-class GET/PUT delegates endpoints.                                           |
| SDK/contracts               | Changed              | Adds typed delegate request/response schemas and manifest persona.                      |
| CLI                         | Unchanged by design  | Existing desired-state CLI remains sufficient; no delegates CLI was requested.          |
| Gantry MCP/admin            | Unchanged by design  | Agent-requested settings changes keep using the existing reviewed settings tool.        |
| Channel/provider adapters   | Unchanged by design  | Core narration text changes but delivery routing/adapters do not.                       |
| Docs/prompts                | Changed              | This audited Stage 8 contract is recorded before implementation.                        |
| Audit/events                | Read-only/observable | Existing operator logging gains one bounded unresolved-ref warning; no new event type.  |
| Tests/verification          | Changed              | Focused unit coverage plus `npm run typecheck`; no full suite.                          |

### Verification

- `npm run typecheck`
- `npx vitest run -c vitest.unit.config.ts <touched unit test files>`
- No full suite, branch change, commit, background process, or runtime restart.

### Stage 8 routing and authority invariants

- A callable target must share the caller route's canonical configured
  conversation id and a compatible thread. JID equality is never an
  authorization boundary, and agent-owned provider-account ids remain target
  execution details rather than shared-conversation identity.
- The delegates GET roster uses the orchestrator's actual selected
  `AgentDelegation` authority and locked/full access posture. It must not force
  authority merely to describe a configured target.
