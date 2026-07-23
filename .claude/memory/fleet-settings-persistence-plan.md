---
name: fleet-settings-persistence-plan
description: "Plan for fleet settings_revisions persistence fix (Part A, ready) + deferred secret-store pluggability (Part B)"
metadata: 
  node_type: memory
  type: project
  originSessionId: ea23fb1c-26f5-40e6-b960-e13936c75761
---

Plan file: `~/.claude/plans/fleet-settings-persistence-vectorized-melody.md` (autoplan-reviewed 2026-06-23). Status: **plan only, not implemented** per user.

**Part A (the real, urgent fix — ship-ready):** In fleet mode the runtime boots from the Postgres `settings_revisions` table, but the two shared mutation choke points — `writeDesiredRuntimeSettings` (desired-settings-writer.ts, ~25 CLI callers) and `syncRuntimeSettingsFromProjection` (restart-sync.ts, ~17 control-API routes + ipc-admin-handlers.ts:847) — only reconcile projection + write ephemeral settings.yaml and never append a revision. So ECS redeploy reverts every CLI/control-API provider/agent/binding/approver mutation. Fix: make both choke points append a revision in fleet (reuse `importWorkstationSettings` + `revisionMirror` / `importFleetSettingsRevision`). Route on `settings.runtime.deploymentMode` but FAIL CLOSED if it's absent with storage present (it defaults to `workstation`). Keep the no-op churn skip (`settingsMatchesLatestRevision`). ~6 files, unit-testable with `FakeRevisionRepo`.

**Part B (DEFERRED to the UI+API work):** secret resolution should stay store-agnostic behind the `RuntimeSecretProvider` port, but the pluggable encrypted-Postgres backend is NOT buildable as first drafted — 3 independent reviewers (CEO+Eng+Codex) agreed. Blockers: (1) `RuntimeSecretProvider.getSecret` is SYNC and called synchronously, so an async Postgres backend needs a boot/reload-hydrated sync cache, not a sync DB call; (2) bootstrap key recursion — `credential-secret-crypto.ts` resolves `SECRET_ENCRYPTION_KEY` through a provider, so the carve-out must be enforced by construction with a process-env-only provider; (3) Slack & Telegram channel adapters read config env directly, not via the port; (4) reuse `gcred:v2` crypto, NOT `CapabilitySecretService` semantics. Fleet secrets already work today via ECS-injected `process_env` (AWS Secrets Manager), so there's no urgent fleet secret bug. User: secret-entry layer is "not permanent" — UI+API will own it.

Relates to [[no-backward-compat]] (silent `.env` removal still flagged for UX, but no compat concern).