---
name: company-brain-core-stage1
description: Brain Stage 1 shipped as PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 84c1b7c7-db24-491d-bfe0-70b0db54c380
---

Company brain Stage 1 (of the harvesting+brain plan, decided 2026-07-07 via
grill-me) shipped as **PR #195**, branch `feature/company-brain-core`, built in
worktree `~/Workdir/myclaw-brain` (Codex xhigh implemented; orchestrator fixed
integration seams). Goal prompt: `docs/architecture/company-brain-core-goal-prompt.md`.

Key seams for later stages:
- All cross-layer composition lives in `apps/core/src/brain/brain-runtime.ts`
  (`createRuntimeBrainService`, `openBrainFromHome`). `apps/core/src/brain/` is
  deliberately UNCLASSIFIED in `.codex/architecture-map.json` — classifying it
  as runtime needs ~4 capped exception entries; flagged in PR as reviewer decision.
- Brain IPC handlers live in `memory-ipc-brain.ts` (memory-ipc.ts has a
  700-line budget). Memory IPC signed scope carries NO app identity — brain
  actions hardcode DEFAULT_MEMORY_APP_ID; multi-app needs signed-scope +
  spawn-projection extension.
- `brain_search`/`brain_query`/`brain_write` are default-allowed IPC actions;
  three capability tests + agent-spawn scope test + migration-journal guard
  test must be updated whenever this surface or a migration changes.
- Stage 2 next: Slack tap harvest (channel-message-ingest) + brain-dream job;
  Stage 3 rides connectors v1 (subscriptions + Gmail delta-poller). See
  [[preexisting-live-admission-failures-main]] for known-red base tests and
  the plan file use-grill-me-skill-binary-pixel.md for all decisions D1-D8.

Runtime smoke deferred: com.gantry runs the MAIN checkout's dist; smoke after
merge (build main checkout, kickstart, gantry brain import, brain_query).

**Stage 2 shipped as PR #196** (feature/company-brain-harvest): channel harvest
tap at channel-persistence-handlers (route-gated — agent-less harvest waits for
Stage 3 pollers), Brain Dreaming job (additive-only, brain_dream_decisions
journal, migration 0094), brain_harvest settings flag. 6 autoreview rounds /
12 fixes; slugs are hash-anchored (`chan-<acct-conv>-<disc>-<hash>`).
