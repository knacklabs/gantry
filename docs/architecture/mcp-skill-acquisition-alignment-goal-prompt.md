# MCP/skill acquisition alignment — goal prompt

Status: **v2 — TOTAL REFACTOR OF PR #237 ON ITS OWN BRANCH (user directive
2026-07-20).** Implemented in worktree `wt-pr237` on `develop`; every commit
updates PR #237 in place. Verdict basis: `pr237-arch-review.md` (16-group
matrix: keep 4 / simplify 2 / reimplement 10) + `pr237-issues-for-dev.md`
(handoff) + the grill-locked decisions below. Cross-check against
`pr237-validation.md` (defect-coverage pass) before closeout so no real fix is
lost in the deletions.

## Refactor stages (each leaves develop green; commit + push per stage)

### Stage R1 — DELETIONS + keeps + simplifications (mostly `git rm`)
Delete the 10 reimplement groups' code wholesale (per the review's commit
refs): the MCP capability sync service + route + CLI + contracts/audit-event +
~700 test lines; the raw third-party `request_access` tool branch
(`59ad050b2`…`4a7d88c12`); the 14-scheduler-durable-grants framework
(`3c92d3f50` reverted); `normalizeStoredRevisionAliases` + alias tests;
`repairLegacyProviderAccountSecretRefs` + table; the deploy workflow's
task-definition rewrite (Terraform inputs instead); the orphan Slack seeder
(`d73d978fe`); the recovery-cursor age cap; the IPC route/field compat readers
(keeping ONLY the send_message provider-account hunk of `55d9adcf5`); the
job-summary rework per review §15. KEEP untouched: CAS settings writes
(`13f199676`, `29863909a`), Slack delivery-failure notices, remote MCP CLI
registration. APPLY the 2 simplifications: strict indexed Slack action-id
regex (drop old-id acceptance); leading-mention-only normalization.
Verify: build + typecheck + full unit green on develop.

### Stage R2 — single-authority MCP action model
The selected reviewed capability PATTERN is the only action authority:
- Typed reviewed MCP pattern binding in `semantic-capabilities.ts`; enforce at
  projection/call time (`agent-tool-runtime-rules.ts:198-214`,
  `mcp-tool-proxy-capabilities.ts:60-75`). Inventory drifts freely without
  mutating authority; newly discovered pattern-matching tools work with no
  exact-list refresh.
- Denials outside the pattern NAME the missing reviewed capability; recovery
  strings are MODE-AWARE (locked/fixed-image agents never told to call hidden
  tools) — trace defect 2.
Verify: unit + the mcp-client-loop e2e still green; new pattern-enforcement
tests.

### Stage R3 — the four grill-locked decisions + remaining trace defects
1. `mcp_search_tools` FTS over INVENTORY (names+descriptions+server;
   semantic-ready interface; no embeddings).
2. Honest receipts (now-vs-next-turn truth; skills + MCP).
3. Reconcile preserves `agent_request`-created active bindings unless
   explicitly removed; inactive-server rows warn+skip (defect 6).
4. Inline ALL installed skills up to `SAME_SESSION_SKILL_CONTEXT_MAX_BYTES`
   with honest truncation line (defect 5).
Plus: projection includes inventory-only servers alongside selected `mcp__`
rules (defect 1); install-time materialization-collision validation (defect 3).

### Stage R4 — tests, matrix, closeout
Integration rows from the E2E section below; flip matrix rows with citations;
update PR #237's body to describe the refactored scope; cross-check
`pr237-validation.md` for any real fix the deletions dropped and restore it
the single-authority way; full verification + independent review on the final
develop diff.

## The product model (user-confirmed, unchanged)

Installs do NOT grant blanket tool permissions. Capabilities are curated mixes
of granular tools + MCP tools + skill tools with explicit read/write
separation. `request_mcp_server` binds INVENTORY-ONLY by design; durable action
requires a reviewed capability. This lane fixes the gaps AROUND that model —
it does not weaken it.

## Trace-confirmed defects and gaps (2026-07-20)

Code bugs:
1. **Second-server projection exclusion** — `authorizedMcpServerIdsForAgent`
   (`mcp-authorized-servers.ts:56-59`): once ANY `mcp__x__` tool rule is
   selected, servers without a matching rule (fresh inventory-only connects)
   are silently excluded from next-turn projection — bound but never
   materialized.
2. **Dead-end recovery guidance** — recovery strings instruct
   `request_mcp_server {...}` even where fixed-image/locked mode hides that
   tool (`tool-execution-policy-service.ts:542-562`).
3. **Deferred-collision failures** — skill materialization collisions surface
   at the NEXT spawn (whole spawn fails) after a success receipt
   (`claude-skill-materializer.ts:189-203`).

Design gaps (locked decisions below address):
4. Same-turn availability over-promise ("available now" is only true for the
   inlined body / gantry-proxy path; SDK surfaces are spawn-frozen).
5. Multi-skill installs inline only the FIRST skill in-turn
   (`ipc-skill-install-handlers.ts:284-290`).
6. Reconcile-replace drops agent-installed bindings
   (`desired-state-capability-reconcile.ts:83-107`); inactive-server rows fail
   whole reconciles (`:313-320`).
7. No runtime tool discovery — agents can't search MCP tools.

Fragility (watch, don't rebuild): bind+sync coupling rolls back working
installs on sync failure (hardened by UX Stage A; re-breakable).

## Locked decisions (grill, 2026-07-20)

1. **FTS tool search now, semantic-ready interface.** One `mcp_search_tools`
   surface over tool names+descriptions+server (Postgres tsvector or
   in-memory; zero new infra). Semantic search plugs into the SAME interface
   later via the existing embedding layer IF a real miss-rate appears. No
   embeddings now (YAGNI at dozens-to-hundreds of tools).
2. **Honest receipts, no mid-run refresh.** Receipts state exactly what is
   usable NOW (inlined skill bodies; MCP via gantry proxy `mcp_call_tool`)
   vs NEXT turn (SDK-registered skill, direct `mcp__` tools — the access
   fingerprint already forces the respawn). Mid-run re-materialization stays
   unbuilt.
3. **Reconcile preserves agent-installed bindings.** Reconcile merges instead
   of blind-replace for `agent_request`-created active bindings: they survive
   unless the revision EXPLICITLY removes them. Inactive-server rows warn+skip
   instead of failing the whole reconcile.
4. **Inline ALL installed skills up to the byte budget** (existing
   `SAME_SESSION_SKILL_CONTEXT_MAX_BYTES` cap), with an honest "N more
   available next turn" line when truncated.

## Also in scope (from the trace's code-bug list)

- Fix defect 1 (projection exclusion): inventory-only bound servers must
  project next turn regardless of existing `mcp__` rule selections (they are
  discoverable inventory; action authorization stays capability-gated).
- Fix defect 2: recovery guidance must be mode-aware — locked/fixed-image
  agents get the honest "provision before the run" phrasing, never a hidden
  tool name.
- Fix defect 3: validate materialization collisions AT INSTALL TIME (name
  collision against currently-selected skills → fail the install receipt
  honestly, not the next spawn).

## E2E rows (ride this lane; add to agent-e2e-test-matrix.md as built)

- Integration: projection includes inventory-only server alongside selected
  `mcp__` rules; reconcile preserves agent-installed binding vs explicit
  removal; install-time collision rejection; mode-aware recovery strings.
- E2e (haiku, once Stage C harness lands): the agent-driven acquisition rows
  already in the matrix (§4/§5) — request → approve → next-turn use; plus
  `mcp_search_tools` used by the agent to find and then call a fixture tool.

## Non-goals

- No blanket permissions on install (the capability model stands).
- No semantic embeddings for tools in v1.
- No mid-run SDK session mutation.
- No changes to the reviewed-capability approval flow itself.

## Sequencing (user directive 2026-07-20: changes go INTO PR #237)

Implementation lands ON PR #237's branch (`develop`) — NOT a separate lane on
main. Flow: (1) `pr237-validation.md` verdict identifies what #237 already
fixes; (2) a worktree on `origin/develop` implements the REMAINING items from
this doc (the four locked decisions + the trace defects #237 doesn't cover) as
additional commits on that branch, keeping every change aligned with the
inventory-only capability model; (3) any #237 change the validation flags as
misaligned/defective gets corrected in the same branch; (4) PR #237 merges as
the single MCP/skill acquisition PR once its CI + the e2e rows are green.
Implementer: Fable subagents, matrix rows flipped with citations at closeout.
