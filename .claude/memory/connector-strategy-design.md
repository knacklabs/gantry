---
name: connector-strategy-design
description: "Approved connector-strategy design (2026-07-02) — direct OAuth in Gantry, Nango providers.yaml as templates, org-owned GitHub+Google v1, non-dev Connectors web UI"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d3ba470-54f8-4a87-bb95-d4014912fd33
---

Office-hours session 2026-07-02 produced an APPROVED design doc:
`~/.gstack/projects/vrknetha-myclaw/ravikiranvemula-connector-strategy-design-20260702-162500.md`
(3 adversarial review rounds, 40 findings fixed). Also mirrored in plan file
`~/.claude/plans/task-notification-task-id-bxu40n7ft-tas-compressed-quail.md`.

Key founder decisions (do not re-litigate):
- **Direct OAuth inside Gantry, NOT embedded Nango** — deployment leanness beat catalog speed; user overrode both Claude and Codex recommendations. Nango swap is a named re-entry path behind the `ConnectorProvider` seam.
- Port Nango's `providers.yaml` format as declarative templates (ELv2 OK, preserve notices; OAUTH2 subset only) so provider #N is config + toolpack, not code. Revoke is per-provider escape-hatch code (not in Nango's format).
- Org-owned connections v1 (one per provider per org, unique constraint), schema keyed `ownerType`/`userId` for per-user later.
- v1 = GitHub + Google end-to-end; Jira coming-soon in catalog. GitHub = OAuth App + machine user (GitHub App is upgrade path); Google = internal-consent GCP app (avoids 7-day test-mode refresh trap), readonly scopes, offline access.
- **Connectors web UI is v1 scope** (founder correction): non-dev admins, gallery/connect/per-tool assignment, magic link → short-lived scoped API key in page memory (no cookies/CSRF), one new REST pair `GET/PUT /v1/agents/:id/connectors/:connectionId`.
- Tokens in capability-secret lane; resolve-on-use per-call core-side over IPC (runner never sees refresh tokens); Postgres advisory-lock single-flight refresh; 401→needs_attention (notify once per transition). No reconnect-on-refresh in v1 (GitHub tokens don't expire).
- Riskiest item: refresh-aware change to the credentialRefs materialization seam. First spike: 1 day to verify GitHub remote MCP server accepts OAuth-app bearer tokens.

Assignment given: dogfood KnackLabs' own gantry ↔ GitHub org full lifecycle; the first three agent tool requests define the real tool catalog.
