---
name: goal-pipeline-mandatory
description: ALL feature implementation must go through the gantry-goal-pipeline skill (goal prompt → Codex stage handoffs → autoreview) — never implement inline
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
  modified: 2026-07-22T11:42:10.302Z
---

User decision 2026-07-14 (during OTel observability work): implementation must ALWAYS use the gantry-goal-pipeline flow, even in future sessions — Claude orchestrates (goal prompt doc, stage splitting, diff inspection, verification, commits), Codex implements via `codex:codex-rescue` handoffs.

**Why:** I had started implementing an approved plan inline; the user stopped me and asked "Are we not using goal prompt skill?" then said "Strictly I want to follow this for implementation even in future."

**How to apply:** After any plan approval in myclaw, invoke `Skill(gantry-goal-pipeline)` instead of editing implementation files directly. Trivial gate/typecheck fixups while orchestrating are acceptable; feature edits are not.

**UPDATE 2026-07-22:** the symphony-forge harness now owns the pipeline for NEW goals (decision 0002; see [[symphony-forge-migration]]): intake → plan → decompose → `/codex:rescue` implement → `.agents/scripts/verify.py` → one autoreview → pr_ready. The gantry-goal-pipeline skill is retained only for in-flight lanes built under it. The spirit of this feedback is unchanged: Claude orchestrates, Codex implements, never inline. Related: [[codex-xhigh-driving-pattern]], [[autoreview-local-before-commit]].
