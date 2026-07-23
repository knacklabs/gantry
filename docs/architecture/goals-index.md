# Goals Index — execution queue + status board

Master tracker for engineering goals. **Scan the board first**, then read the
stage detail below it. Each goal links a detailed goal-prompt / audit / roadmap
doc in this folder. Done-vs-pending reconciled against merged PRs 2026-07-22.

Every implementation cycle runs through the gantry-goal-pipeline (Codex
implements, Claude orchestrates) with a mandatory Codex plan-validation pass on
the goal doc before stage 1, per AGENTS.md.

**Status vocabulary:** `shipped` (merged) · `staged` (built, not merged) ·
`in-flight` (building now) · `build-ready` (design locked, deps clear) ·
`scoped`/`locked` (design done, not queued) · `roadmap` (needs a prior cycle +
design) · `ideation` (not yet scoped).

**Checklist legend:** `[x]` merged · `[~]` built, staged (not merged) ·
`[>]` in flight · `[ ]` pending.

**This file = DURABLE status** (committed, survives sessions). Live session
mechanics — Codex task ids, worktree paths, in-flight lane state — live in the
session-state scratchpad, which points back here for canonical status. Do not
duplicate status between them (that is bug-family 1 — same fact, two lifecycles).

**Standing habit (user directive 2026-07-19): bug-pattern-driven simplification.**
At every cycle closeout, classify that cycle's review findings into pattern
families; recurring families re-rank this queue toward the simplification that
retires them. Families observed (2026-07-19, ~35 findings): (1) same fact stored
twice with different lifecycles — the dominant family; (2) mutation-before-
authorization / delivery-failure confused with commit failure; (3) consolidation
fidelity loss when unifying copies; (4) generated defaults blind to deployment
reality; (5) type-system lies.

---

## Status board — active goals (scan here first)

| Goal | Progress | Active now | Blocked on |
|---|---|---|---|
| Permission engine redesign | design ✅ · plan ⏳ · build ⏳ | writing plan | fold in floor+promotion + simplification |
| Observer program | 1/6 shipped · 2/6 staged · 3/6 pending | land S2 + S3a | my verify → autoreview → merge |
| Agent E2E merge gate | foundation + core rows shipped | many rows pending; matrix tracker itself behind | per-row, in progress |
| Capability authoring | committed on `feature/capability-authoring` (13ae2e698), not merged | verify → review → merge | edits mcp-tool-proxy → blocks MCP hybrid |
| MCP hybrid search | design ✅ · build ⏳ | — | capability-authoring must land first |
| Ponytail audit | phased re-derive in progress (wt-ponytail) | reconcile phase live | final cutover GATED — your go, any red = STOP |

**Pending / queued goals:** see the **Queued**, **Then**, and **Parked** sections
below — those hold the authoritative order and readiness (do not duplicate them
here). _(Permission floor+promotion is folded into the permission engine
redesign; Fail-loud audit writes is unscoped — Parked, not queued.)_

---

## Active goals — stage detail

### Permission engine redesign  ·  PENDING (design locked, unbuilt)
Live git/sandbox pain root-caused to AUTHORIZATION (not sandbox). Design LOCKED:
deterministic risk analyzer + decision memory + ask-once-genuine-risk. Design of
record committed: `permission-engine-redesign-goal-prompt.md` + `git-permission-rca.md`.
- [x] Root-cause RCA (git prompts = authorization; direct mode not the lever)
- [x] Design locked (risk analyzer · decision memory · classifier shrinks · ask-once)
- [ ] Network/FS investigation — Codex ran, **output unrecovered** (grill from code instead)
- [>] Full implementation plan (grilling now)
- [ ] Fable + Codex adversarial critique of the plan (security-critical)
- [ ] Build via goal-pipeline (git deterministic-gate = slice #1)
- **Consolidation:** supersedes `permission-floor-and-promotion-goal-prompt.md`
  and folds `permission-simplification-goal-prompt.md`; also fixes telemetry
  (RunCommand command text) + `select:`-as-Bash misparse.

### Observer program  ·  IN PROGRESS (1 shipped, 2 staged, 3 pending)
Curious Observer: harvest firehose → nightly dream → deterministic value floor +
batch LLM judge → private ≤1/day digest. Behind `observer.enabled` (default off).
Design of record: session `proactive-observer-plan.md`. API+SDK+E2E every stage.
- [x] S1 foundations — MERGED **#264** (proactive_insights, deliveries, cursors, read-only API/SDK/E2E)
- [~] S2 emission — was an UNCOMMITTED diff in `wt-observer-s2`; rescued as WIP
      `e055dc14a` on `feature/observer-s2-emission` 2026-07-22 (floor conf≥0.6 · evidence≥1 · dedup cosine≥0.86)
- [~] S3a batch-core + fix — was an UNCOMMITTED diff in `wt-observer-s3`; rescued as WIP
      `a51a4909d` on `feature/observer-s3-batch` 2026-07-22 (gateway batch endpoints, prefer-orphan state machine; 7 autoreview fixes applied)
- [ ] S3b — xAI Grok + Kimi transports (same declared-capability slot)
- [ ] S4 — digest delivery (staging · settlement · freshness revalidation · evidence permalinks · feedback capture · artifact)
- [ ] S5 — setup wizard + preview + status + cold-start backfill
- **Next action:** verify → autoreview → PR → merge S2 and S3a. Exclude the
  plan/GOAL scratch docs from the autoreview *diff* only — do NOT delete the
  design record.
- **Contract gap CLOSED 2026-07-22:** the design of record is committed as
  `proactive-observer-goal-prompt.md` (promoted verbatim from the scratchpad).

### Agent E2E CI merge gate  ·  IN PROGRESS (many rows pending)
Packaged real-image runtime + real agent turn + evidence; the merge bar. Goal
doc: `agent-e2e-ci-merge-gate-goal-prompt.md` (RESTAGED v3). Row tracker
`agent-e2e-test-matrix.md` is itself BEHIND (PRs #256–#261 added tests without
flipping its rows), so neither it nor this checklist is a reliable count —
reconcile the matrix separately before trusting any "% done".
- [x] Gate foundation — **#238** (CI-gated postgres lanes, fixture kit)
- [x] Stage C packaged-runtime harness — **#242**
- [x] First real haiku turn — **#246**
- [x] Matrix rows: permission chain **#256** · memory/route **#257** · jobs lifecycle **#258** · boot+onboarding **#259** · capabilities **#260** · delegation **#261**
- [>] Many matrix rows still pending: packaged boot/restart, haiku model gate, all-tools coverage, security/recovery
- [ ] Flip `agent-e2e-gate` to a **required check** (LAST — only when the matrix is green)
- **Next action:** reconcile the matrix tracker, then work the pending batches. NOT near closeout.
- _Reconciled 2026-07-22: `feature/agent-e2e-haiku-turn` carries 15 commits with a
  real +382/−11 diff vs main beyond merged #246 (streamed-reply proof
  strengthening) — salvage-or-discard during the matrix reconciliation._

### Capability authoring  ·  ACTIVE LANE (committed, unmerged)
The lane that lets agents author capabilities; edits `mcp-tool-proxy.ts`. Blocks
MCP hybrid search — both edit mcp-tool-proxy, so no concurrent edits.
- [~] Rescued 2026-07-22: the wt-pr237 diff is committed verbatim as
  `feature/capability-authoring` @ 13ae2e698 (WIP snapshot — not reviewed, not verified)
- [ ] Verify + review the lane → then it (and MCP hybrid) can proceed
- **Source of record:** branch `feature/capability-authoring` (no goal-prompt yet).

### MCP hybrid search  ·  BLOCKED (design locked, dep unmet)
Extends `mcp_search_tools`: FTS ranking + light stemming + opt-in semantic layer
(reuses memory's embedding provider + cache; degrades to FTS). Goal doc:
`mcp-hybrid-search-goal-prompt.md` (GRILL-LOCKED 2026-07-21).
- [x] Design grill-locked
- [x] Dep: #237 on main (`mcp_search_tools` live)
- [ ] Dep: capability-authoring landed — **NOT met** (uncommitted in wt-pr237,
      edits `mcp-tool-proxy.ts`; both efforts touch it → concurrent edits forbidden)
- [ ] Build (plan-validation → stages → autoreview → PR)
- **Status: blocked on capability-authoring landing.** NB: capability *catalog*
  (#255, merged) is a different thing from capability *authoring* (the wt-pr237 lane).

### Ponytail audit (separate track, gated)  ·  IN PROGRESS (unmerged lane)
Main-sync re-derive + phased cutover on `feature/ponytail-audit` (unmerged).
Reconciled vs the lane git log 2026-07-22:
- [~] Phases 1–7 committed in-lane through `9ffa146c2` (Phase 7 = 102 migrations
      replaced by one 93-table baseline + Phase-8 offline restamp/reset/rollback runbook)
- [~] Post-Phase-7 in-flight diff (169M+22?? — capability guards, tool-permission-gate,
      query-loop re-derive) rescued as WIP `e4104edc8` 2026-07-22
- [ ] Phase 8: final offline cutover / live restamp — **GATED**: explicit user cutover
      go + fresh-green + required e2e rows green; **any red = STOP**. Nothing merged to main.

---

## Queued — design locked, not started (run top-to-bottom when a slot opens)

1. **Durable-work primitive** — **FIRST post-Ponytail-cutover lane** (recorded
   user directive 2026-07-20); plan-validation complete. Refactors jobs/
   interactions state that Ponytail Phases 5–6 move. Its goal-prompt
   (`durable-work-primitive-goal-prompt.md`) landed on this tree 2026-07-22.
2. **Model management: unify then UX** — FINALIZED 2026-07-19; starts when the
   ponytail lane closes (shares the settings parser/renderer surface). Folds in
   `status-cost-cache-visibility-goal-prompt.md`. _Salvage candidate:
   `codex/model-management-agent-tool` (6 commits, unmerged)._
   `model-management-goal-prompt.md`
3. **Media render capability + env-facts** — **NOT runnable — gated on
   validation, do NOT auto-run.** Round-3 plan-validation
   (`media-render-plan-validation-round3.md`) = NOT APPROVED FOR IMPLEMENTATION
   (unresolved sandbox + capability-routing). The v4 FACADE-PREFLIGHT delta needs
   a fresh validation pass + a committed v4 goal-prompt before the pipeline.
   Queues after the E2E gate. _Reconciled 2026-07-22: NO lane work exists —
   `feature/media-render-capability` has zero unique commits (the old "wt-media
   (unmerged)" note was wrong)._ `media-render-goal-prompt.md`
4. **S3/MinIO file-artifact bytes** — protocol decided (pending-row + upload +
   verified commit + TTL janitor); LOW PRIORITY (live uses local). _Reconciled
   2026-07-22: `feature/s3-file-artifacts` holds ONE stage-1 commit marked
   `[HOLD] ... commit-first ... NOT for merge` — it predates the decided
   pending-row protocol and needs rework to it, not a straight merge._
   `artifact-store-s3-goal-prompt.md`
5. **OTel permission/decision spans** — goal-prompt committed
   (`otel-permission-spans-goal-prompt.md`); reconciled 2026-07-22: NOT
   started (the `feature/otel-permission-spans` branch has no unique work;
   its tmp worktree was wiped — nothing lost). OTel shipped so far: base
   #220 · dev-observability #209 · tool-execution spans #262.

## Then — medium, scoped

5. **Jobs recovery-intent → columns + CAS.** `coordination-representation-audit-2026-07-18.md` (B1)
6. **Coordination hardening batch** — advisory locks, TOCTOU fallback, serializer unify. (B2)
7. **`desired-state-current-export` rewrite** — schema-driven merge, fail-loud. (Group C)
8. **Remaining Fable arch cycles** (#2–#8). `fable-architecture-review-2026-07-16.md`

## Parked — goal-prompt on disk, unscoped (verified 2026-07-22)

Verified against merged PRs 2026-07-22 — five of the seven former entries had
in fact SHIPPED (#185/#186/#192/#193; moved to Shipped below). Still parked:
- `multi-agent-provider-onboarding-goal-prompt.md` — no merged PR; salvage
  candidate lane `codex/multi-agent-provider-onboarding` (6 commits, unmerged).
- `deepagents-cache-savings-goal-prompt.md` — no merged PR, no lane.

Unscoped fixes with NO goal doc yet (symptom + proposed counter only — need a
goal-prompt + plan-validation before scheduling):
**Fail-loud audit writes** — `runtime_events` insert in `publishGatewayUseAudit`
throws WARN-swallowed; add a failure counter so silent audit loss can't hide.

## Roadmap — after the above, needs design

- **KB / document ingestion per workspace.** `platform-roadmap-2026-07.md` (#1)
- **Tenant isolation hardening** — hostile-tenant review; verified via E2E matrix. (#3)
- **E2E persona/topology harness** — the scratchpad draft was lost; re-draft
  deferred as D-0002 (trigger: E2E matrix reconciliation).
- **Connector strategy execution** — direct OAuth, `providers.yaml`, org-owned
  GitHub+Google v1 _(design doc in `~/.gstack` projects dir)_.

## Ideation — not yet scoped (do not auto-start)

- **Prompt-driven flows** — natural-language flows, not node/edge authoring.
- **Identity + memory MCP** — personId alias (link-don't-merge), person-scoped
  memory MCP; rides the connector strategy.
- **Blueprints + per-tenant evals.** `platform-roadmap-2026-07.md` (#4, LATER)

---

## Lane hygiene — worktree triage

Live worktree/lane state is ephemeral, so it lives in the session scratchpad
(`SESSION-STATE.md`), NOT this durable board. To triage stale worktrees,
regenerate the list on demand: `git worktree list` + `gh pr list --state merged
--limit 80`, then `git -C <path> status --short` on each before any
`git worktree remove` — a merged branch can still hold uncommitted work (e.g. the
capability-authoring lane). Do not maintain a worktree list here.

## Shipped (reference only — do not re-execute)

- Observer S1 foundations — #264.
- Cross-provider conversation context — **#185**. `cross-provider-conversation-context-goal-prompt.md` _(was mislabeled Parked until the 2026-07-22 reconciliation)_
- Generative UI / rich interaction rendering — **#186**. `generative-ui-goal-prompt.md` _(v1; was mislabeled Parked)_
- Event-driven waits + durable async burst queue — **#192** (one PR, two goal docs). `event-driven-waits-agent-subagent-goal-prompt.md`, `durable-async-tool-burst-queue-goal-prompt.md` _(were mislabeled Parked)_
- Non-blocking session compaction — **#193**. `non-blocking-session-compaction-goal-prompt.md` _(was mislabeled Parked)_
- OTel trace enrichment (span taxonomy beyond base) — **#262** _(verify full
  agent/LLM/tool/MCP taxonomy scope before reopening)_. `otel-llm-observability-goal-prompt.md`
- Agent output style — **#243**. `agent-output-style-goal-prompt.md`
- Agent E2E: foundation #238 · Stage C #242 · first real turn #246 · matrix rows #256/#257/#258/#259/#260/#261.
- Capability Catalog (source-agnostic ready-actions projection) — #255.
- Session interaction-response API — #252.
- MCP/skill acquisition single-authority refactor (PR #237 develop→main).
- Messaging hot-path Stages 1–2 — #235/#236. Stage 3 CLOSED (YAGNI). `messaging-hotpath-and-liveness-goal-prompt.md`
- Silence allow-for-future permission receipts — #239.
- Security advisory gate fixes — axios #244 · shell-quote #249 · fast-uri #263.
- Route-loader dedup + conversationId leak — #247.
- Conversation quality V1+V3+V4 — #232. `conversation-quality-goal-prompt.md`
- Permission durable-storage simplification — #233. `permission-durable-storage-goal-prompt.md`
- Group onboarding (one-tap join) — #231.
- Agents-as-tools (callable-agent delegation) — #230. `agents-as-tools-goal-prompt.md`
- Classifier/SSRF bug fixes — #229.
- OTel LLM observability base + UX A–D — #220. `otel-llm-observability-goal-prompt.md`
- C+D prompt-lifecycle / question-recovery envelope — #228.
- Auto-permission mode/action-based/classifier/run-origin-trust — #212.
- Lightweight agent modes — #207. `lightweight-agent-modes-goal-prompt.md`
- Inline-agent feature parity (lightweight phase 2) — #208. `inline-agent-feature-parity-goal-prompt.md`
- Onboarding stale-settings fix — #205. `onboarding-stale-settings-goal-prompt.md`
- Status/cost/cache visibility (base; UX remainder folds into model-management) — #201. `status-cost-cache-visibility-goal-prompt.md`
- Dev experience Tier 1 — #209. `dev-guardrails-and-usage-goal-prompt.md`, `dev-control-and-observability-goal-prompt.md`
- Setup/management UX overhaul — #200. `setup-management-ux-goal-prompt.md`
- Company brain core — #195; Stage 2 (Slack tap + dream job) shipped (`01b3b45da` + fix `0be885dab`). `company-brain-core-goal-prompt.md`, `company-brain-harvest-goal-prompt.md`
- Arch quick wins (error counters, log correlation, durable send ordering) — #226.

---

_Maintenance: when a goal ships, tick its stage `[x]` with the PR number and move
the row to **Shipped**. When a new audit lands, add its doc and slot it into the
board. Keep durable status HERE; keep session mechanics in the scratchpad._
