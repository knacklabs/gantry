# Refactor Gap Closure Plan

> **Audience:** the executing agent picking this up cold.
> **Companion to:** `runtime-refactor-plan.md` and `memory-continuity-fixes-plan.md`. Read both before starting.
> **Author context:** drafted by main_agent after validating the in-flight 86-file refactor (working tree at HEAD `d18ba5f0`, +1845/-563) against the two parent plans. The refactor lands real work, including protected-capability guard changes, dreaming unsafe-evidence quarantine, and deletion of `script-runner.ts`, but leaves the changes that would actually unblock day-to-day agent driving on the floor. This plan finishes the job before merge.

---

## 0. How to use this document

1. Read top-to-bottom before touching code.
2. Verify each anchor in §6 against the working tree before relying on it. The refactor is uncommitted; line numbers will drift on rebase.
3. Phases are ordered by leverage. Phase 1 unblocks the next session of memory recall; Phase 2 unblocks autonomous jobs. Do them first.
4. This plan is **pre-merge**. Each phase ends with "ready to fold into the in-flight refactor commit," not a separate PR. Goal is to ship one principled refactor, not three.
5. Honour both parent plans' non-negotiables. Conflicts resolve in favour of the parent.

---

## 1. Mission

Close the gap between what the in-flight refactor shipped and what the parent plans demanded, so the refactor can merge as "done" instead of "checkpoint."

## 2. Thesis

Three statements. Conflict with any of them means the gap is not closed.

1. **The refactor is judged by what changes for a driving agent, not by lines moved.** A capability-guard rewrite that does not also fix subject threading does not move the daily experience. The user-facing repros are the scoreboard.
2. **No "ready to continue" merges.** Either the merged tree satisfies the parent plans' phase exit criteria, or the merge waits.
3. **Tools without handlers are not surfaces; they are bugs.** Boot must fail loud on registration without handler. This is non-negotiable, not aspirational.

## 3. Non-negotiables

1. **Pre-merge checklist (§7) must be 100% green** before this branch lands on `main`.
2. **Every gap closed has a repro that fails on the current working tree and passes after the fix.** No "should work" claims.
3. **Net delta on this branch must turn negative or hold flat.** Current branch is +1282 net; gap-closure work must offset, not extend.
4. **No new tool surface in this plan.** Every fix below operates on existing surfaces.
5. **Boot-time tool-registry check ships in this branch.** Otherwise the next "list_notification_targets"-class bug is inevitable.

## 4. Gaps to close (verified against the in-flight diff)

| #   | Gap                                                                                     | Evidence                                                                                                                   | Severity    |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------- |
| G1  | `DEFAULT_MEMORY_AGENT_ID` still live; subject not threaded from session                 | `apps/core/src/memory/app-memory-boundaries.ts:13,54`                                                                      | **blocker** |
| G2  | Permission timeout not split; autonomous jobs still wait 300s on prompts no one answers | `apps/core/src/shared/permission-timeout.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/runtime-env.ts:27-35`                           | **blocker** |
| G3  | Boot does not fail when an MCP tool is registered without a handler                     | obsolete memory ingestion tools were unregistered; scheduler handler parity still needs verification                       | **blocker** |
| G4  | No `scheduler_cancel_run` and no watchdog reaping zombie `running` rows                 | parent plan A Phase 2                                                                                                      | high        |
| G5  | Telegram chunker still markdown-unaware; long replies truncate silently                 | `apps/core/src/channels/telegram/channel-shared.ts:132-155`, partial-delivery surface                                      | high        |
| G6  | `formatOperatorError(err)` helper not introduced; three-line errors only ad-hoc         | spot-checked at `permission-callback.ts:175-176`, `channel-wiring-interactions.ts:44`, `runner/mcp/tools/scheduler.ts:220` | medium      |
| G7  | Browser facade `status.cdpReady` must stay tied to browser/CDP readiness, not model gateway health | `apps/core/src/runtime/ipc-browser-handler.ts` and browser IPC tests                                                       | medium      |
| G8  | Net delta of this branch is +1282 lines, violating parent non-negotiable                | `git diff --stat HEAD` summary                                                                                             | medium      |

## 5. Phases

Each phase: **goal**, **scope**, **exit criteria**, **deletion target**, **repro**.

### Phase 1 — Subject threading (G1)

**Goal:** my next `memory_search` from `main_agent` returns real results.

**Scope:**

- Delete `DEFAULT_MEMORY_AGENT_ID` at `apps/core/src/memory/app-memory-boundaries.ts:13`. Surface every implicit caller as a TypeScript error.
- Introduce `resolveSessionSubject(session) → { agentId, scope, groupFolder }` in `apps/core/src/memory/app-memory-subject-resolver.ts`. Single definition.
- Memory MCP handlers (`memory_search`, `memory_save`) read subject from the session context their handler runs in. Caller may _override_ scope (with audit), not invent agent.
- Migration `0048_memory_subject_backfill.sql`: rewrite rows currently keyed `agent:personal` to the resolved subject by inspecting `groupFolder`. No dual-read path.
- Empty-result responses include the subject used so silent zero-results die.

**Exit criteria:**

- Grep for `DEFAULT_MEMORY_AGENT_ID` returns zero hits.
- Grep for `agent:personal` literal in non-test runtime code returns zero hits.
- **Repro:** `memory_search('knacklabs lead controller job')` from a `main_agent` session returns at least the manually-saved test memory with provenance and the resolved subject.

**Deletion target:** ≥150 lines net.

### Phase 2 — Permission timeout split (G2)

**Goal:** autonomous jobs stop hanging on prompts no human will answer.

**Scope:**

- `apps/core/src/shared/permission-timeout.ts` exposes `getPermissionTimeoutMs(context: 'interactive' | 'autonomous')`. Interactive defaults 15000ms; autonomous defaults 0ms.
- Autonomous-context callers (job runner) skip the IPC entirely on 0ms — fall through to the merged capability allowlist. No prompt fires.
- Interactive denial message names the missing rule and points to the reviewed
  capability or narrow `request_permission` path. Persistent fallback remains
  limited to semantic capabilities, canonical `Browser`, exact Gantry admin
  tools, exact Gantry file/web facades, or scoped `RunCommand(...)` rules.
- Configurable via env, but defaults are the spec'd values.

**Exit criteria:**

- **Repro:** queue a job whose prompt needs a `Bash` rule not on its allowlist; run via `run_now`. Run finishes within 1s with a denial that names the missing rule. No 5-minute hang.
- **Repro:** in interactive chat, deny a rule and confirm timeout fires at 15s, not 300s.
- Grep for `300_000` / `300000` as a permission-timeout default returns zero hits.

**Deletion target:** ≥40 lines net.

### Phase 3 — Boot-time tool-registry check (G3)

**Goal:** ship a tool only when its handler exists.

**Scope:**

- Add a focused runner/MCP registry check: at boot, iterate the tool registry; for each registered surface, assert a handler is bound. Throw on missing handler, halting boot.
- Wire into the runner startup before any MCP traffic accepts.
- Smoke test: register a fake tool with no handler in test mode → boot fails with the offending tool name.
- Verify `scheduler_list_notification_targets` either has a handler or is unregistered. Do not ship a "hide it from list" workaround — fix or remove.

**Exit criteria:**

- Boot fails loud on missing-handler in test.
- `mcp_list_tools` returns only tools that pass the registry check.
- **Repro:** the `Unsupported IPC task type` error class is no longer reachable from a registered tool.

**Deletion target:** offset Phase 3's additions; net 0 acceptable.

### Phase 4 — Scheduler cancel + watchdog (G4)

**Goal:** zombie `running` rows die without a runtime restart.

**Scope:**

- `scheduler_cancel_run` MCP tool with handler. Cancels via the watchdog cancel path, sets `error_summary` on the run.
- Independent watchdog worker (separate event loop / thread) reaps any `running` row past `timeout_ms + grace`. Marks as `failed` with `error_summary: 'watchdog_timeout'` and an event.
- Watchdog also cancels the runner subprocess; cooperative `setTimeout` paths in `apps/core/src/jobs/execution.ts:100-223,395` removed in favour of the watchdog.

**Exit criteria:**

- **Repro:** wedge a runner deliberately (e.g., infinite sleep). Within `timeout_ms + 1s`, the run is marked failed with a real `error_summary` and the subprocess is reaped.
- `scheduler_list_runs` shows no `running` row older than its budget in any environment.
- Grep for cooperative timeout patterns in scheduler/runner returns zero hits.

**Deletion target:** ≥150 lines net (cooperative paths consolidate into the watchdog).

### Phase 5 — Telegram chunker honesty (G5)

**Goal:** long markdown replies round-trip losslessly; partial delivery is loud.

**Scope:**

- Rewrite `iterTelegramTextChunks` (`apps/core/src/channels/telegram/channel-shared.ts:132-155`) as markdown-aware: code fences and links are atomic; chunk on safe boundaries.
- Unify direct (`channel-delivery.ts:35-97`) and streaming (`99-212`) paths: escape _then_ chunk. Single helper.
- `PartialMessageDeliveryError` from `apps/core/src/domain/messages/partial-delivery.ts` reaches the operator: surface on the channel as a follow-up message saying "tail dropped, see logs," do not log-and-mark-delivered.
- Group streaming overflow (`channel-state.ts:431-442`) raises, not silently truncates.

**Exit criteria:**

- **Repro:** post a 30KB markdown reply with code fences and links via the agent. Concatenated chunks un-escape to byte-equal source.
- **Repro:** simulate a Telegram 400 on chunk 3-of-4. Operator receives an explicit partial-delivery message; the run does not falsely report `delivered`.

**Deletion target:** ≥100 lines net (chunking + escape paths consolidate).

### Phase 6 — Operator error helper (G6)

**Goal:** every operator-facing error has the three lines.

**Scope:**

- Add `formatOperatorError(err) → { summary, cause, recover }` in a focused shared error-formatting module. Unwraps `err.cause` chain; recover step required.
- Replace inline error construction at the audited surfaces (Telegram delivery, MCP tool results, scheduler events, permission denials, credential broker errors in `agent-credential-service.ts`).
- Lint rule or grep-based CI check: `new Error(\`` outside the helper triggers a warning in `apps/core/src/{runner,jobs,channels,application}`.

**Exit criteria:**

- Every error reaching a user surface includes summary + cause + recover.
- The credential-broker repro (`mcp_call_tool` while broker is down) returns the underlying socket/errno, not just the wrapper string.
- Grep for ad-hoc `new Error(\`` in operator-surface paths trends toward zero.

**Deletion target:** ≥80 lines net (string concatenation collapses).

### Phase 7 — Browser surface honesty (G7)

**Goal:** Browser facade `status.cdpReady` reflects browser driveability.

**Scope:**

- `browser_status` checks browser process and CDP readiness only. Model gateway
  and credential readiness belong to `gantry credentials`/`gantry doctor`, not
  the browser status surface.
- `mcp_list_tools` / `mcp_call_tool` failures during broker outage return the cause chain (Phase 6 helper), not the wrapper.

**Exit criteria:**

- **Repro:** disable model gateway credentials. Browser facade status remains
  available, reports browser/CDP readiness from the browser backend, and exposes
  no `brokerHealth` fields.
- No path returns `cdpReady: true` for a browser the agent cannot drive.

**Deletion target:** ≥30 lines net.

### Phase 8 — Net-delta repair (G8)

**Goal:** the merged branch satisfies the parent non-negotiable on deletion.

**Scope:**

- Track running net delta after each phase. Phases 1, 2, 4, 5, 6 are net-negative by design; Phase 3 is offset.
- Final pass: identify any compat shims, dead branches, or deprecated paths left after Phases 1–7 and delete them.
- Target: branch lands at ≤ 0 net lines vs `main`. If unavoidable, document the floor with reason in the PR description.

**Exit criteria:**

- `git diff --stat main...HEAD` shows net ≤ 0.
- No `// TODO: clean up after refactor` remains.

**Deletion target:** whatever closes the gap.

## 6. Code anchors (verify before relying)

| Concern                              | Path                                                                | Line                   | Phase |
| ------------------------------------ | ------------------------------------------------------------------- | ---------------------- | ----- |
| Default memory agent constant        | `apps/core/src/memory/app-memory-boundaries.ts`                     | 13, 54                 | 1     |
| Permission timeout module            | `apps/core/src/shared/permission-timeout.ts`                        | (whole file)           | 2     |
| Runtime env permission timeout       | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/runtime-env.ts`                        | 27–35                  | 2     |
| Memory tool registrations            | `apps/core/src/runner/mcp/tools/memory.ts`                          | 159–207                | 3     |
| Scheduler tool handlers              | `apps/core/src/runner/mcp/tools/scheduler.ts`                       | 195–250                | 3, 4  |
| Job execution cooperative timeout    | `apps/core/src/jobs/execution.ts`                                   | 100–223, 395           | 4     |
| Telegram chunker                     | `apps/core/src/channels/telegram/channel-shared.ts`                 | 132–155                | 5     |
| Telegram delivery (direct/streaming) | `apps/core/src/channels/telegram/channel-delivery.ts`               | 35–97, 99–212, 243–268 | 5     |
| Partial delivery surface             | `apps/core/src/domain/messages/partial-delivery.ts`                 | 91–99                  | 5     |
| Group streaming overflow             | `apps/core/src/channels/telegram/channel-state.ts`                  | 431–442                | 5     |
| Permission denial message            | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/permission-callback.ts`                | 175–176                | 6     |
| Model gateway error wrap             | `apps/core/src/application/credentials/agent-credential-service.ts` | 80–83                  | 6, 7  |

## 7. Pre-merge checklist

- [ ] G1 — `memory_search` from `main_agent` returns real results; `DEFAULT_MEMORY_AGENT_ID` deleted.
- [ ] G2 — autonomous job hits no permission prompt; interactive timeout is 15s.
- [ ] G3 — boot fails on tool-without-handler; `scheduler_list_notification_targets` either completes or is removed.
- [ ] G4 — wedged runner reaped within budget + 1s; `scheduler_cancel_run` ships with handler.
- [ ] G5 — 30KB markdown round-trips; partial delivery surfaces to operator.
- [ ] G6 — `formatOperatorError` adopted at audited surfaces; credential-broker error includes cause.
- [ ] G7 — Browser facade `status.cdpReady` lies no more.
- [ ] G8 — branch net delta ≤ 0 vs `main`.
- [ ] All repros above produce the expected output on a clean clone.
- [ ] Both parent plans' Phase 1 exit criteria are green.

## 8. Risks and mitigations

| Risk                                                                        | Mitigation                                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Subject backfill migration mis-keys rows                                    | Migration is dry-run-able; emits per-row before/after; rollback reverts to `agent:personal` on the affected rows only. |
| Autonomous 0s timeout breaks a legitimate "human is watching this run" case | Job config flag `interactive: true` opts an autonomous run into the interactive timeout. Default false.                |
| Watchdog false-cancels long but legitimate runs                             | Per-job `timeout_ms` is the budget; watchdog only acts past `timeout_ms + grace`. Smoke test for known-long jobs.      |
| Markdown-aware chunker over-conservative; fewer chunks                      | Acceptable; lossless > compact. Chunk count surfaced in `memory_status`-style telemetry for the channel.               |
| Net-delta target forces premature deletion                                  | Net target measured at branch end, not per-phase; phases may run net-positive if the branch closes negative overall.   |

## 9. Decision rules for the executing agent

1. **If a parent-plan non-negotiable conflicts with this plan, the parent wins.** Update this plan in the same PR; do not invent exceptions.
2. **No new tool surface.** Every fix here is on an existing surface or in shared/.
3. **Repro before claim.** A gap is closed only when its repro flips. "Should work" is not closure.
4. **Delete first.** If a path is dead after a phase's change, delete it in the same phase.
5. **If the working tree shifts under you (the refactor is uncommitted), re-anchor §6 before continuing.**

## 10. Definition of done

- Pre-merge checklist green.
- Both parent plans' Phase 1 exit criteria green.
- One repro session demonstrates: a fresh `main_agent` session injects continuity → recall returns real results → autonomous job runs without hanging → wedged job is reaped → long markdown reply round-trips → operator errors carry the three lines.
- Branch merges as one principled refactor, not a checkpoint.
- This plan moved to the architecture history folder with a closing note: actual deletion delta, what shipped, what was cut, what carried over.

## 11. Out of scope

- Anything not in the gap table §4. New work belongs in a new plan.
- Changes to either parent plan's phasing or non-negotiables.
- Ground-up rewrites of the watchdog, capability layer, or scheduler. This plan finishes; it does not restart.

---

**End of plan.** Pre-merge checklist is the verification target. When all eight items flip and the branch net-delta is non-positive, the refactor merges.
