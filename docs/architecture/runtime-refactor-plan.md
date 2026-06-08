# Gantry Runtime Refactor Plan

> **Audience:** the executing agent picking this up cold.
> **Author context:** drafted by main_agent after a long driving session that surfaced a coherent set of architectural failures (issues #95, #97, #98, #99 with sub-issues A–E, plus the SecTrust sandbox regression and the missing `scheduler_list_notification_targets` IPC handler). Read those issues first; this plan is the response to them.

---

## 0. How to use this document

1. Read it top-to-bottom once before touching code.
2. Treat **§2 Thesis** and **§3 Non-negotiables** as constraints, not suggestions. If a step seems to violate one, stop and ask — do not invent an exception.
3. Verify every code anchor (file:line) before relying on it. The codebase moves; if an anchor is stale, re-locate the symbol and update this doc in the same PR.
4. Work phase-by-phase. Do **not** start a later phase before the prior phase's exit criteria are green.
5. Keep PRs small and merge-able. One concept per PR. Reference this plan and the relevant issue.

---

## 1. Mission

Replace the current Gantry runtime with a smaller, principled runtime that an autonomous agent can drive without supervision.

The current runtime is **optimistic in the wrong direction**: it assumes things succeeded, assumes a human is watching, and assumes wedged components will recover. The new runtime must be **pessimistic by default**: verify, preempt, surface.

## 2. Thesis

Three statements. If any future decision conflicts with them, the decision is wrong.

1. **Capability mediation is the primary control plane, not the OS sandbox.** The sandbox is defense-in-depth; the capability system decides what an agent may do. Every action passes through one explicit gate.
2. **Every async boundary has an independent watchdog.** A wedged component cannot enforce its own timeout. Timeouts live outside the thing they bound.
3. **No surface ships without a working backend.** Tools, status fields, and delivery confirmations either reflect reality or do not exist. "Looks healthy" is a lie we no longer ship.

## 3. Non-negotiables

These hold for every PR in this refactor.

1. **Deletion budget.** Every PR must delete at least as many lines as it adds, averaged across the phase. Track in the PR description.
2. **No silent success.** A function that returns `ok` returned `ok` because the work happened, not because no exception was thrown.
3. **No new tool without a handler.** A tool surface (`mcp_list_tools`, `scheduler_*`, etc.) is registered only when its IPC handler exists and a smoke test exercises it end-to-end.
4. **Errors carry three things.** What broke, why (with `err.cause` chain unwrapped), how to recover. See §5.2.
5. **Timeouts are preemptive.** Cooperative timeouts are not allowed. See §5.3.
6. **Capability rules are durable and inspectable.** Allowed capability state either lands in the durable store and is visible via `scheduler_get_job` / `capability_status`, or it didn't happen.
7. **No compatibility mode.** This is a rewrite with deletion. Old behaviour is replaced, not flagged.
8. **No new abstractions without two callers.** If only one caller exists, inline it.
9. **Single source of truth for capability config.** One file format, one merge order, one place that resolves it.
10. **Tests are smoke, not unit-mock theater.** Each phase ships at least one test that exercises the real IPC path with a real Postgres.

## 4. Target architecture (5 layers)

```
┌──────────────────────────────────────────────────────────┐
│ L5  Surfaces       Telegram, MCP tools, scheduler API    │
├──────────────────────────────────────────────────────────┤
│ L4  Runner         Claude Code subprocess + streaming    │
├──────────────────────────────────────────────────────────┤
│ L3  Capability     Single gate: policy → allow → audit    │
├──────────────────────────────────────────────────────────┤
│ L2  Watchdog       Independent timeout + cancel for L4   │
├──────────────────────────────────────────────────────────┤
│ L1  Persistence    Postgres: jobs, runs, access, events   │
└──────────────────────────────────────────────────────────┘
```

Cross-cutting:

- **Egress gateway** sits beside L4. Outbound network is default-allow with an
  optional root settings hostname denylist, not a provider-owned allowlist.
- **OS sandbox** wraps L4 only. It is read-mostly: deny writes outside `~/Workdir`, `/tmp/claude`, and `$TMPDIR`. Allow read of system trust store (fixes SecTrust regression).
- **Continuity injector** reads from L1 and writes into the L4 prompt. Not a tool; a fixed pre-step.

## 5. Cross-cutting standards

### 5.1 Capability rule format

An allowed capability entry is a tuple: `{ scope, rule, approved_by, approved_at, reason }`.

- `scope`: `org | agent:<id> | run:<id>` — merged in that order, narrowest wins on conflict, additive otherwise. Scheduled jobs resolve the target agent scope at run time instead of carrying separate job-local authority.
- `rule`: a reviewed semantic capability entry such as `capability:acme.records.append`, canonical `Browser`, an exact Gantry file/web facade such as `FileRead`, an exact Gantry admin tool, or a scoped command fallback rule such as `RunCommand(npm test *)`. Broad exact SDK/native request_permission authority and exact third-party MCP tool names are not durable authority. Browser remains the canonical whole browser capability.
- Persisted in the agent capability stores and mirrored to readable `settings.yaml` capability entries.
- `scheduler_get_job` returns the **effective** target-agent rule set for the job, not a job-local authority slice.

### 5.2 Error format

Every error reaching an operator surface (Telegram, MCP tool result, scheduler event) must include:

```
<one-line plain-English summary>
cause: <unwrapped err.cause chain — errno/status/host/path>
recover: <exact next step the operator can take>
```

Implemented as a single helper, `formatOperatorError(err)`. Anything that constructs an error message by string concatenation is removed.

### 5.3 Timeout discipline

Every blocking call has:

1. A **budget** (ms) declared at the call site.
2. A **watchdog** running on a separate event loop / process that fires `cancel` when the budget elapses.
3. A **cancel path** that the awaiter respects within ≤1s.

If any of those three is missing, the call is not allowed to ship. The watchdog lives in L2 and is shared across L4 callers.

### 5.4 Permission IPC defaults

- Interactive context: 15s, deny on timeout, error tells the operator which rule to grant.
- Autonomous context: 0s — fall straight through to the job allowlist. No prompt fires when no human is in chat.

## 6. Phases

Each phase has: **goal**, **scope**, **exit criteria**, **deletion target**, **anchor verification list**.

### Phase 0 — Lock the deletion budget and anchors

**Goal:** establish the baseline so progress is measurable.

**Scope:**

- Run `python3 .codex/scripts/check_refactor_line_delta.py --baseline` and record per-directory line counts in `docs/architecture/refactor-baseline.md`.
- Verify every code anchor in §8 is current. Update if stale. Fail the phase if more than 20% are stale — that means the codebase has shifted enough to re-plan.
- Keep the CI/factory check live: PRs labelled `refactor` must show non-positive net runtime source line delta.

**Exit criteria:**

- Baseline file committed.
- CI check live.
- Anchor table in §8 verified with commit SHA `d18ba5f08a6496c462d27edf36773cb8a88cc4fe`.
- Phase 0 anchor verification found 2 stale path anchors out of 12: apps/core/src/channels/telegram/partial-delivery.ts was removed, and apps/core/src/jobs/agent-capabilities.ts moved. The stale-path rate is 16.7% and does not require re-planning.

**Deletion target:** 0 (setup phase).

### Phase 1 — Capability layer (L3)

**Goal:** one gate, one merge order, one durable store.

**Scope:**

- Build on the current shared policy seam instead of creating a greenfield module by default: `ToolExecutionPolicyService` already exists in `apps/core/src/shared/tool-execution-policy-service.ts` and `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts` already routes interactive and autonomous SDK tool decisions through it.
- Consolidate active capability composition in `apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts`. The old apps/core/src/jobs/agent-capabilities.ts anchor is stale and must not be recreated as a compatibility path.
- Keep scheduled job capability behavior honest: jobs inherit target-agent capabilities and must not grow a separate authority writer. Phase 1 must route missing capability recovery through the same reviewed request tools used by interactive agents.
- `scheduler_get_job` already exposes effective allowed tools from inherited agent capabilities. Phase 1 must make that effective set resolve from durable capability state with the declared `org -> agent -> run` merge order.
- Complete the missing durable pieces: add durable capability authority, persist one inspectable permission/capability decision record, and make allow/check/resolve use that store.
- Tighten the protected-capability guard so text payloads are allowed when safe and only target mutations of `.claude/`, `.mcp.json`, provider capability paths, or `settings.yaml` are denied. The current shared policy service contains target-oriented logic, but still has fail-closed protected-path mention branches that Phase 1 must verify against §99-D.

**Exit criteria:**

- One call site for "is this allowed."
- §99-A repro (persistent authority for autonomous job) passes.
- §99-D repro (`gh issue create` with capability words in body) passes.
- Smoke test: approve a rule, restart the runtime, rule still applies.

**Deletion target:** ≥600 lines net.

### Phase 2 — Watchdog layer (L2)

**Goal:** preemptive timeouts everywhere.

**Scope:**

- New `apps/core/src/watchdog/` running on a separate worker thread (not the main event loop).
- Every `await` that crosses a process or IPC boundary registers a budget with the watchdog.
- Permission IPC, scheduler runs, MCP calls, Telegram sends all migrate to this.
- `scheduler_cancel_run` MCP tool ships in this phase, calling the watchdog cancel path. Closes #98.

**Exit criteria:**

- A wedged runner process is reaped within `timeout_ms + 1s`, verified by integration test that deliberately wedges a child.
- No `setTimeout`-based cooperative timeouts remain in the runner or scheduler. Grep clean.
- Stuck `running` rows older than their budget are auto-failed by the watchdog with a real `error_summary`.

**Deletion target:** ≥400 lines net.

### Phase 3 — Surface honesty (L5)

**Goal:** no tool ships without a backend; no delivery lies about success.

**Scope:**

- Tool registration becomes declarative: a tool listed in the registry must have a handler import, checked at boot. Boot fails loud otherwise. Closes the `scheduler_list_notification_targets` class of bug.
- Telegram delivery: rewrite chunker as markdown-aware (treat code fences and links as atomic), unify direct and streaming paths, escape-then-chunk, never both. Surface `PartialMessageDeliveryError` to the operator, not the warn log. Closes #97.
- Browser facade `status` reflects driveability, not just process liveness. If the credential broker is dead, `cdpReady=false`. Closes #95.
- `formatOperatorError` adopted by every surface. Grep for `new Error(\`` should be near zero outside the helper.

**Exit criteria:**

- Boot-time registry check live.
- §97 repro (long markdown reply) round-trips losslessly.
- §95 repro (broker outage) returns the real cause and a recover step.
- Every error that reaches an operator includes the three lines.

**Deletion target:** ≥500 lines net.

### Phase 4 — Sandbox + egress firewall

**Goal:** sandbox is defense-in-depth, capability is the primary gate. SecTrust regression fixed.

**Scope:**

- Sandbox profile narrowed to: deny writes outside `~/Workdir`, `/tmp/claude`, `$TMPDIR`; allow read of system trust store and Keychain trust evaluation (read-only). Fixes the `gh` OSStatus -26276 regression.
- Egress firewall (host-side) replaces the in-sandbox network rules. Allowlist is per-job, resolved by L3.
- Sandbox smoke test: `gh api user` and `curl https://api.github.com` both succeed; if they diverge, CI fails.

**Exit criteria:**

- `gh issue create` works from inside the agent's Bash subprocess without a workaround.
- A job whose capability set excludes `api.github.com` cannot reach it even with `curl --cacert`.

**Deletion target:** ≥200 lines net (sandbox profile simplification).

### Phase 5 — Continuity injection

**Goal:** dreaming output reaches sessions; agents self-bootstrap.

**Scope:**

- Auto-promote low-risk staged memories (factual, no contradictions). Reserve human review for preference-style memory.
- New `memory_status` tool: last dream run, candidates staged, candidates promoted, brief size injected at session start.
- Open commitments surfaced as an explicit prompt block at session start, not as an optional tool call.
- `continuity_summary` tool: last N runs, agent-filed open issues, paused jobs, recent decisions.

**Exit criteria:**

- A fresh session for `main_agent` injects non-empty continuity that includes any commitments older than 24h.
- §99-C repro passes.

**Deletion target:** ≥150 lines net.

### Phase 6 — Scheduler hardening

**Goal:** the scheduler is the authority on run state, not the runner.

**Scope:**

- Lease ownership moves to the scheduler; the runner reports progress, not state.
- Run state transitions are a single state machine in a jobs run-state module. No ad-hoc `UPDATE jobs.runs SET status = ...` calls outside it.
- `scheduler_list_events` becomes the canonical event log; `error_summary` is required on `failed` and `cancelled`.

**Exit criteria:**

- Killing the runner mid-run leaves the scheduler in a recoverable state within one watchdog tick.
- Every terminal state has either a non-empty `error_summary` or an explicit `success: true` event.

**Deletion target:** ≥300 lines net.

### Phase 7 — Decommission

**Goal:** delete the parallel old paths.

**Scope:**

- Remove the legacy permission callback, the substring guard, the cooperative timeouts, and any compat shims left from earlier phases.
- Final cloc against the Phase 0 baseline. Net delta must be ≥ –2000 lines or the refactor failed its own thesis.

**Exit criteria:**

- No `// TODO: remove after refactor` comments remain.
- No file imports both `legacy/` and the new modules.
- `docs/architecture/agent-runtime.md` rewritten against the new layout. Old diagrams removed.

**Deletion target:** ≥500 lines net.

## 7. Cross-phase exit checklist

- [ ] All eight closes-#XX claims verified by repro from a clean clone.
- [ ] No tool in `mcp_list_tools` returns `unsupported_task_type`.
- [ ] No `running` row older than its budget exists in any environment for >1 watchdog tick.
- [ ] Telegram round-trip of a 30KB markdown reply with code fences is byte-equal after un-escape.
- [ ] `gh api user` succeeds from inside an autonomous job's Bash subprocess.
- [ ] A fresh `main_agent` session shows continuity with at least the most recent open commitment.
- [ ] Net line count vs Phase 0 baseline: ≤ –2000.

## 8. Code anchors (verify in Phase 0)

| Concern                                              | Path                                                                | Line             | Phase |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ---------------- | ----- |
| Model gateway error wrap                             | `apps/core/src/application/credentials/agent-credential-service.ts` | 97–126           | 3     |
| Telegram streaming formatter                         | `apps/core/src/channels/telegram/channel-shared.ts`                 | 131–138          | 3     |
| Telegram direct delivery chunking and partial errors | `apps/core/src/channels/telegram/channel-delivery.ts`               | 53–158           | 3     |
| Telegram private streaming divergence                | `apps/core/src/channels/telegram/channel-delivery.ts`               | 161–273          | 3     |
| Partial-delivery domain error and metadata           | `apps/core/src/domain/messages/partial-delivery.ts`                 | 30–113           | 3     |
| Partial-delivery durable recovery handling           | `apps/core/src/app/bootstrap/runtime-services.ts`                   | 627–640          | 3     |
| Partial-delivery delivery status handling            | `apps/core/src/jobs/delivery.ts`                                    | 57–82            | 3     |
| Group streaming overflow/truncation path             | `apps/core/src/channels/telegram/channel-state.ts`                  | 317–395          | 3     |
| Permission callback (file IPC, blocks)               | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/permission-callback.ts`                | 72–177           | 1, 2  |
| Permission timeout default 5min                      | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/runtime-env.ts`                        | 27–35            | 1     |
| Job timeout and lease budget setup                   | `apps/core/src/jobs/execution.ts`                                   | 99–124           | 2     |
| Job runner callback path                             | `apps/core/src/jobs/execution.ts`                                   | 380–395          | 2     |
| Mutate-handler decision options                      | `apps/core/src/jobs/ipc-scheduler-mutate-handlers.ts`               | 58–80            | 1     |
| `future_config_version` style flag                   | `apps/core/src/jobs/ipc-admin-handlers.ts`                          | 407–415          | 1     |
| Active capability composition                        | `apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts`                        | 68–95, 294–338   | 1     |
| Shared tool execution policy service                 | `apps/core/src/shared/tool-execution-policy-service.ts`             | 139–185, 226–339 | 1     |
| Scheduler authority tool appends job policy          | `apps/core/src/runner/mcp/tools/scheduler.ts`                       | 198–250          | 1     |
| Effective job tool view                              | `apps/core/src/application/jobs/job-visibility-metadata.ts`         | 139–147          | 1     |
| Job policy update persistence                        | `apps/core/src/application/jobs/job-management-helpers.ts`          | 343–345          | 1     |
| Bash autonomous allowlist check                      | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`                         | 239–270          | 1     |

Removed or stale Phase 0 anchors:

- apps/core/src/channels/telegram/partial-delivery.ts no longer exists. Partial-delivery state now lives in `apps/core/src/domain/messages/partial-delivery.ts`, with runtime recovery handling in `apps/core/src/app/bootstrap/runtime-services.ts` and job delivery status handling in `apps/core/src/jobs/delivery.ts`.
- apps/core/src/jobs/agent-capabilities.ts no longer exists. Active capability composition is `apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts`.

## 9. Risks and mitigations

| Risk                                               | Mitigation                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Watchdog false-cancels long but legitimate work    | Per-call-site budgets, not a global default; smoke tests for known-long calls.                                 |
| Capability rule format change breaks existing jobs | Phase 1 ships a one-shot migration that rewrites `jobs.target_json`. No dual-format read path.                 |
| Egress denylist blocks too broadly                 | Default-allow remains the baseline; denylist entries are explicit hostname globs with audit on every decision. |
| Auto-promotion of memories surfaces wrong facts    | Phase 5 limits auto-promote to factual + no-contradiction; preference memories still queue for review.         |
| Refactor stalls in a half-state                    | Phase 7 deletion budget is enforced; if missed, phase reopens. No "we'll come back to it."                     |

## 10. Decision rules for the executing agent

When in doubt:

1. **Delete first, refactor second.** If a code path can be removed with no caller, remove it. Do not modernize dead code.
2. **No new file unless an old file goes away in the same PR.** Net file count is also tracked.
3. **No new dependency unless it removes ≥2 internal modules.** This is a deletion refactor.
4. **No flag, no toggle, no "compat mode."** If you find yourself adding one, you are off-plan.
5. **If a §3 non-negotiable is in your way, stop and ask.** Do not invent an exception in code.

## 11. Definition of done

- All seven phases' exit criteria met.
- Cross-phase checklist green.
- `docs/architecture/agent-runtime.md` rewritten and the old version deleted.
- This plan moved to a dated file under docs/architecture/history/ with a closing note: actual deletion delta, what shipped, what was cut, what carried over.

## 12. Out of scope

- New features. Anything that adds a capability rather than fixing one is out.
- UI work outside Telegram delivery and MCP tool surfaces.
- Multi-tenant / multi-host concerns. Single-host runtime stays single-host.
- Migrating off Postgres or off the Anthropic SDK.

---

**End of plan.** Open issues #95, #97, #98, #99 (sub-issues A–E), the SecTrust sandbox regression, and the `scheduler_list_notification_targets` handler gap are the verification set. When all of them close from a clean repro, this refactor is done.
