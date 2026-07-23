---
name: setup-ux-overhaul-pr200
description: PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 4db9f26a-be43-4858-9370-cd7974ce934b
---

PR #200 (`feature/setup-management-ux`, opened 2026-07-08) shipped the six-stage setup/management UX overhaul per `docs/architecture/setup-management-ux-goal-prompt.md` (execution contract, in-repo): 1 stale-guard save fix, 2 preset retirement (model-first, `memoryModelDefaultsForProvider`), 3 wizard memory step + re-run jump menu + step headers, 4 live key verify (setup/set/rotate/doctor + Slack live check), 5 multi-agent slice (menu add-agent, `--agent` flag), 6 restart-required surfacing. FIFTEEN autoreview rounds ran to convergence (clean at round 15); every accepted finding fixed + regression-pinned — highlights: gateway projection env names per provider, store-anyway honored in verify, family aliases preflight the runtime's configured-first member, route/account ownership never reassigned, secret redaction in verification errors, fail-closed on uncatalogued models, thinking budget floor. The reviewer repeatedly emitted a phantom "brain write guidance" finding with no file in the diff — ignore it if it reappears.

**Why:** grilled decisions: model-first (presets killed), embeddings OpenAI-or-off, re-runnable setup as the one front door, live verify skippable.

**How to apply:** remaining unverified: interactive runtime smoke (fresh `GANTRY_HOME` setup walk + re-run menu scenarios need a real terminal, Postgres, channel tokens). Integration/e2e suites not run (known pre-existing red on main, see [[preexisting-live-admission-failures-main]]). Channel-switch semantics changed deliberately: persisting a new primary no longer disables the other enabled channel.

**Update (2026-07-09):** second autoreview convergence at round 30 (clean) after Bedrock/Vertex single-credential memory (memory workloads enabled — they ride the same DeepAgents lane as groq/gemini), Vertex live verify via the hardened gateway token path, bedrock chain resolution, and a full family-alias consistency sweep (preflight/resets/parser/API/readiness all resolve families credential-aware via `resolveModelFamilyAlias`, storage-first via `listReadyModelCredentialProviders`). PTY smoke (expect + docker pgvector, extensions must be pre-created) validated the wizard through the channel-token step; remaining manual: real Telegram/Slack token for Create Runtime → ready + re-run menu scenarios. Smoke infra: container `gantry-smoke-pg` port 55433 + `/tmp/gantry-smoke-*` home.
