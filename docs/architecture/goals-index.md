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
Family 1 evidence spans permission storage (cured by #233), settings export
(Group C), and async tasks (callable-agent follow-up state added NEW jsonb-key
state in privateCorrelationJson) — which is why the durable-work primitive
precedes Group C. 2026-07-19 validation-loop additions: family 3 struck again
(appId-less desired-state provider vs its appId-passing sibling — ponytail
slice 1), family 2 flavor in Slack attachment double-failure reported as
success, and a fresh TOCTOU (workspace attachment containment) reinforcing the
B2 hardening batch.

---

## Execution order (run top-to-bottom)

**Now — three in-flight lanes (2026-07-19, all uncommitted in worktrees, each
carrying a validation addendum in its linked doc that MUST land before commit):**

1. **Ponytail audit Phase 3** — slice 1 implemented (N1/N5-N7/N9, AR1 19→0);
   fix round in flight for 2 P1s (appId-less provider + test dedup — addendum in
   `ponytail-audit-2026-07-16.md`); then slice 2 (AR2+F5+F14 canonical routing),
   slice 3 (F9+N2-N4+N8), Phases 4-6; Phases 7-9 (DB baselining + live restamp)
   LAST, only after explicit user cutover go + the live-settings runbook in the
   branch execution ledger. _(worktree `wt-ponytail`, `feature/ponytail-audit`)_
2. **Outbound attachments fix (all providers)** — items 1-4 implemented; fix
   round in flight for the validation addendum in
   `outbound-attachments-audit-2026-07-19.md` (containment TOCTOU, Slack
   `files:write` scopes, double-failure propagation). Then PR.
   _(worktree `wt-attach`, `fix/outbound-attachments`)_

Per-lane loop: codex fix lands → independent verify (typecheck + FULL unit +
throwaway-DB integration when schema touched) → local autoreview to clean →
commit. Merge only on explicit user "merge NNN".

**Next — high-leverage:**

4. **Durable-work primitive — LOCKED: starts when the attachments lane closes (after its S3/MinIO follow-on cycle); runs IN PARALLEL with goal 5 (user decision 2026-07-19)** (evidence-promoted
   2026-07-19): unifies ~10 bespoke lease/claim/retry copies; absorbs deferred
   retention + IPC-backpressure + fire-and-forget `send_message` + A3
   review-dedup (deferred from the perm-storage cycle) + the NEW callable-agent
   follow-up jsonb-key state (privateCorrelationJson/receiptJson flags from
   #230 — same family-1 disease); the umbrella for goals 6-7 below. Starts with
   a Codex plan-validation pass. `fable-architecture-review-2026-07-16.md` (#1)
5. **Model management: unify then UX** — FINALIZED 2026-07-19; starts when the ponytail lane closes, parallel with goal 4 (8 decisions
   locked in the doc: aggressive knob collapse, sticky conversation switch via
   settings-approval gate, tokens+cache stats, disclosed cheapest-sibling
   auto-upgrade); folds in `status-cost-cache-visibility-goal-prompt.md`;
   Stage B rides the V3 phrase seam. `model-management-goal-prompt.md`

**Then — medium, scoped:**

6. **Jobs recovery-intent → columns + CAS.** `coordination-representation-audit-2026-07-18.md` (B1) — may fold into goal 4.
7. **Coordination hardening batch** — skill-install advisory lock, session-compaction Set, TOCTOU fallback, canonical-serializer unify, stringify dedup keys. `coordination-representation-audit-2026-07-18.md` (B2 + low) — may fold into goal 4.
8. **`desired-state-current-export` rewrite** — schema-driven merge, fail-loud on unknown fields. `coordination-representation-audit-2026-07-18.md` (Group C)
9. **Permission decision simplification** — one sequencer, one mode vocabulary, one authority block, one copy layer. `permission-simplification-goal-prompt.md`
10. **Remaining Fable arch cycles** (#2–#8). `fable-architecture-review-2026-07-16.md`

**Roadmap — after the above, needs design:**

13. **KB / document ingestion per workspace.** `platform-roadmap-2026-07.md` (#1)
14. **Tenant isolation hardening** — hostile-tenant review; verified via the E2E harness matrix. `platform-roadmap-2026-07.md` (#3)
15. **E2E persona/topology harness** — goal-prompt drafted in session scratchpad _(promote into this folder as `e2e-harness-goal-prompt.md`)_.
16. **Connector strategy execution** — direct OAuth, `providers.yaml` templates, org-owned GitHub+Google v1 _(design doc in `~/.gstack` projects dir)_.

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

- Conversation quality V1+V3+V4 (agent voice, casual-control mappings via
  reviewed flows, edit-in-place progress cards) — PR #232; V2 stays UI-gated.
  `conversation-quality-goal-prompt.md`
- Permission durable-storage simplification (sweep, one recovery orchestrator,
  `permission_prompts` envelope schema, 12 invariants) — PR #233. `permission-durable-storage-goal-prompt.md`
- Group onboarding (one-tap join registration + CLI/settings fixes) — PR #231.
- Agents-as-tools (per-orchestrator callable-agent delegation, 6 stages) — PR #230. `agents-as-tools-goal-prompt.md`
- Classifier/SSRF bug fixes (truncation-gate split, pinning egress for direct-mode SDK) — PR #229.
- OTel LLM observability + UX stages A-D consolidation — PR #220. `otel-llm-observability-goal-prompt.md`
- C+D prompt-lifecycle / question-recovery envelope — PR #228 (its write-only
  leftovers were deleted by #233 by design). `cd-envelope-durability-fix.md`
- Auto-permission mode/action-based/classifier/run-origin-trust — PR #212. `auto-permission-*-goal-prompt.md`
- Lightweight agent modes — PR #207 (phase 2 goal still open). `lightweight-agent-modes-goal-prompt.md`
- Dev experience Tier 1 (guardrails/usage, control/observability) — PR #209. `dev-guardrails-and-usage-goal-prompt.md`, `dev-control-and-observability-goal-prompt.md`
- Setup/management UX overhaul — PR #200. `setup-management-ux-goal-prompt.md`
- Company brain core — PR #195 (Stage 2 = Slack tap + dream job open). `company-brain-core-goal-prompt.md`, `company-brain-harvest-goal-prompt.md`
- Arch quick wins (error counters, per-turn log correlation, durable send ordering) — PR #226.

---

_Maintenance: when a goal ships, move its row to **Shipped** with the PR number.
When a new audit lands, add its doc here and slot it into the execution order._
