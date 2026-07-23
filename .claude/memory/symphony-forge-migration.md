---
name: symphony-forge-migration
description: "Harness migration COMPLETE 2026-07-22 — dual-runtime clean, legacy .codex rehomed, harvest done; human gates (sign-off, decision accepts, skill installs) pending"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c9e273e-e330-47f5-8b1a-6cb51d1e0af1
  modified: 2026-07-22T11:56:35.605Z
---

Symphony-forge harness is the workflow engine for myclaw as of 2026-07-22 (adopt ddfe0d614 + cleanup commits d0dd7619..403f85165). `check_dual_runtime.py` is CLEAN; factory-scaffold CI checks, 99 harness tests, 67 script tests, typecheck all green.

**What moved where:**
- Live product gates: `.codex/scripts` → `scripts/` (check_architecture + map/exceptions JSONs, check_package_contents, check_runtime_images, check_refactor_line_delta, production_benchmark_gates, postgres env helpers, agent_chat_test); package.json + live docs updated.
- Legacy factory machinery/prompts/rules DELETED (git history has them; decision `0002-symphony-forge-adoption`). Codex destructive-command guardrails preserved at `~/.codex/rules/gantry.rules` (incl. autoreview allow rule).
- Decisions: 28 pre-harness records renumbered 0005–0033 with frontmatter (historical acceptance transcribed, confirmed_by vrknetha); 0026 superseded-by 0028. New proposed: 0002 adoption, 0003 no-backcompat, 0004 naming.
- Old lessons → `plans/lessons.jsonl` via forge (plans/ un-gitignored for harness ledgers; only active/completed/debt stay ignored).
- Verify contract pinned in `.envrc`: FACTORY_STRUCTURAL_CMD="npm run format:check && npm run check:architecture", TYPECHECK="npm run typecheck", TEST="npm test".
- Rescues: wt-pr237 capability-authoring diff committed as `feature/capability-authoring` @ 13ae2e698 (WIP, unreviewed); Observer design → `proactive-observer-goal-prompt.md`; permission RCA → `git-permission-rca.md`; durable-work goal-prompt landed on main.

**Gates CLOSED 2026-07-22 evening:** all three skill packs installed (doctor fully green); decisions 0002/0003/0004/0034 accepted by Ravi (commit 14d8a9441); sign-off grill passed (4 questions — tenancy scope, owner-state manual migration, roadmap source, dropped-scope deferrals D-0001/D-0002) and `client_signoff` recorded. NB: accept status-flips stale a recorded grill — re-record the grill after accepts, then record_signoff. Nothing pushed to origin yet.

**Next gates:** epics grill + `epics-approved` decision (human accept) → `./forge roadmap import` seeded from goals-index + goal-prompt acceptance criteria (per DISCOVERY). Structural verify (`npm run check:architecture`) is RED on baseline: 5 files over line budget (genai-spans 1488/700 worst) + ~130 dangling doc refs; line-budget violations are never waived per review-instructions — first harness story should be the paydown, or user consciously trims FACTORY_STRUCTURAL_CMD.

**Known-red baseline (NOT regressions):** check:architecture fails on file-size budgets + ~108 pre-existing dangling doc refs; ~23 more dangling refs in historical docs (codex-harness, codex-self-improvement, ponytail-audits) point at deleted .codex files by design.

New goals now flow: intake → plan (plan mode, grill, plan save) → decompose → /codex:rescue implement → .agents verify → one autoreview → pr_ready. Related: [[goal-pipeline-mandatory]], [[proactive-observer-program]], [[permission-engine-redesign]].
