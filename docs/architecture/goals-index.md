# Goals Index — execution queue

Master ordered list of engineering goals so they can be executed one after the
other. Each row links a detailed goal-prompt / audit / roadmap doc in this
folder. Status: **in-flight** · **ready** (scoped, blocked only on an earlier
row) · **roadmap** (needs an earlier cycle + some design) · **ideation** (not
yet scoped) · **shipped** (reference).

Every implementation cycle runs through the gantry-goal-pipeline (Codex
implements, Claude orchestrates) with a mandatory Codex plan-validation pass on
the goal doc before stage 1, per AGENTS.md.

**Standing habit (user directive 2026-07-19): bug-pattern-driven simplification.**
At every cycle closeout, classify that cycle's review findings into pattern
families; recurring families re-rank this queue toward the simplification that
retires them. Families observed so far (2026-07-19 session, ~35 findings):
(1) same fact stored twice with different lifecycles — the dominant family;
(2) mutation-before-authorization / delivery-failure confused with commit
failure; (3) consolidation fidelity loss when unifying copies; (4) generated
defaults blind to deployment reality (migrations); (5) type-system lies.
Family 1 evidence spans permission storage (cured by goal 6), settings export
(Group C), and async tasks (callable-agent follow-up state added NEW jsonb-key
state in privateCorrelationJson) — which is why goal 5 now precedes Group C.

---

## Execution order (run top-to-bottom)

**Now — close out the three in-flight branches:**
1. **C+D prompt-lifecycle (#228)** — GREEN; branch autoreview → commit + push → user merge → smoke. `cd-envelope-durability-fix.md`
2. **OTel LLM observability (#220)** — stages 1-5 done; closeout + Langfuse smoke → PR. `otel-llm-observability-goal-prompt.md`
3. **Agents-as-tools** — stages 1-4 done+verified; stages 5 (projection lanes) + 6 (trace nesting) → PR. `agents-as-tools-goal-prompt.md` *(on `feature/agents-as-tools`)*

**Next — high-leverage, blocked only on the above:**
4. **July-16 ponytail legacy audit** — ~19,400 lines; DB reset approved. `ponytail-audit-2026-07-16.md`
5. **Durable-work primitive — LOCKED NEXT after the two in-flight cycles** (evidence-promoted 2026-07-19): unifies ~10 bespoke lease/claim/retry copies; absorbs deferred retention + IPC-backpressure + fire-and-forget `send_message` + A3 review-dedup (deferred from goal 6) + the NEW callable-agent follow-up jsonb-key state (privateCorrelationJson/receiptJson flags from #230 — same family-1 disease); the umbrella for goals 7–8 below. `fable-architecture-review-2026-07-16.md` (#1)
6. **Permission durable-storage simplification** — APPROVED 2026-07-19, IN PROGRESS: sweep → one recovery orchestrator → merged envelope-row schema; 12-invariant test contract. `permission-durable-storage-goal-prompt.md` (validated by `permission-durable-storage-plan-validation.md` + `permission-storage-fable-codex-verification.md`)

**Then — medium, scoped:**
6b. **Outbound attachments fix (all providers)** — QUEUED for lane 2 after the ponytail audit converges (live incident 2026-07-19): loud reason-bearing failures, workspace-direct file resolution in send_message, Slack upload adapter, Teams line-rewrite fix. `outbound-attachments-audit-2026-07-19.md`
7. **Jobs recovery-intent → columns + CAS.** `coordination-representation-audit-2026-07-18.md` (B1) — may fold into goal 5.
8. **Coordination hardening batch** — skill-install advisory lock, session-compaction Set, TOCTOU fallback, canonical-serializer unify, stringify dedup keys. `coordination-representation-audit-2026-07-18.md` (B2 + low) — may fold into goal 5.
9. **`desired-state-current-export` rewrite** — schema-driven merge, fail-loud on unknown fields. `coordination-representation-audit-2026-07-18.md` (Group C)
10. **Permission decision simplification** — one sequencer, one mode vocabulary, one authority block, one copy layer. `permission-simplification-goal-prompt.md` (sequenced after goal 4)
11. **Conversation quality** — agent voice, kill the developer trailer, plain-prose failures. `conversation-quality-goal-prompt.md`
12. **Remaining Fable arch cycles** (#2–#8). `fable-architecture-review-2026-07-16.md`

**Roadmap — after the above, needs design:**
13. **KB / document ingestion per workspace.** `platform-roadmap-2026-07.md` (#1)
14. **Tenant isolation hardening** — hostile-tenant review; verified via the E2E harness matrix. `platform-roadmap-2026-07.md` (#3)
15. **E2E persona/topology harness** — goal-prompt drafted in session scratchpad *(promote into this folder as `e2e-harness-goal-prompt.md`)*.
16. **Group onboarding UX fix** — one-tap join approval + CLI bugs (queued after auto-permission).
17. **Connector strategy execution** — direct OAuth, `providers.yaml` templates, org-owned GitHub+Google v1 *(design doc in `~/.gstack` projects dir)*.

**Ideation — not yet scoped (do not auto-start):**
- **Prompt-driven flows** — natural-language flows, not node/edge authoring; deferred.
- **Identity + memory MCP** — personId alias (link-don't-merge), person-scoped memory MCP, UI last; rides the connector strategy.
- **Blueprints + per-tenant evals.** `platform-roadmap-2026-07.md` (#4, LATER)

---

## Other goal-prompts on disk (status to verify before scheduling)

`cross-provider-conversation-context-goal-prompt.md` ·
`generative-ui-goal-prompt.md` ·
`durable-async-tool-burst-queue-goal-prompt.md` ·
`event-driven-waits-agent-subagent-goal-prompt.md` ·
`non-blocking-session-compaction-goal-prompt.md` ·
`status-cost-cache-visibility-goal-prompt.md` ·
`inline-agent-feature-parity-goal-prompt.md` ·
`multi-agent-provider-onboarding-goal-prompt.md` ·
`onboarding-stale-settings-goal-prompt.md` ·
`deepagents-cache-savings-goal-prompt.md`

## Shipped (reference only — do not re-execute)

- Auto-permission mode/action-based/classifier/run-origin-trust — PR #212. `auto-permission-*-goal-prompt.md`
- Lightweight agent modes — PR #207 (phase 2 goal still open). `lightweight-agent-modes-goal-prompt.md`
- Dev experience Tier 1 (guardrails/usage, control/observability) — PR #209. `dev-guardrails-and-usage-goal-prompt.md`, `dev-control-and-observability-goal-prompt.md`
- Setup/management UX overhaul — PR #200. `setup-management-ux-goal-prompt.md`
- Company brain core — PR #195 (Stage 2 = Slack tap + dream job open). `company-brain-core-goal-prompt.md`, `company-brain-harvest-goal-prompt.md`
- Arch quick wins (error counters, per-turn log correlation, durable send ordering) — PR #226.

---

_Maintenance: when a goal ships, move its row to **Shipped** with the PR number.
When a new audit lands, add its doc here and slot it into the execution order._
