---
name: ux-stage-a-landing
description: UX Stage A (skill installs + settings-sync stability) working live; commit + Stages B-D pending; key gotchas
metadata: 
  node_type: memory
  type: project
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

Stage A of runtime-permission-ux (branch feature/otel-llm-observability, PR #220) confirmed WORKING live by user 2026-07-15 after ~46 ledger rows (docs/architecture/runtime-permission-ux-assumptions.md). Uncommitted; round-13 local autoreview launched, then commit as logical commits (skill installs / settings-sync stability / group delivery / delegation unsandbox), then Stage B (allow-leaning auto mode), C (prompt UX + BUTTON_DATA_INVALID), D (stream boundary) per docs/architecture/runtime-permission-ux-goal-prompt.md.

**Why:** the goal prompts are refreshed and Codex-ready; don't re-derive scope.

**How to apply:**
- Canonical-form transitions: after changing settingsToRevisionDocument, the RUNNING old binary's watcher mints old-form head revisions → stale-retry legitimately never converges. Restart runtime BEFORE any live sync acceptance.
- Live acceptance harness: `syncRuntimeSettingsFromProjection` via dist in a node -e script against ~/gantry (writes one revision; that's fine). Dry-run-validating only the raw export misses import-path bugs — canonicalize + reconstruct too.
- Autoreview runs: launch detached (`nohup ... & disown`) + a background-Bash `until ! ps -p` waiter; codex:codex-rescue forwarder times out at 10min and its background children get killed. Codex must NEVER run autoreview in-session (wedges).
- sanitizeOutboundLlmText is all-or-nothing per input; failure relays apply it PER-LINE or one opaque token (npm log paths) nukes the whole diagnostic.
- Round-12 held/rejected: async-unsandbox stays per user decision [[no-timed-grant-permission]]-style lock (ledger A.43/A.46); fleet cross-process CAS remains the A.16 follow-up.
