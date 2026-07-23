---
name: group-onboarding-ux-fix
description: "QUEUED next after auto-permission mode: one-tap group-join onboarding + 4 CLI bugs found live registering a new Telegram group"
metadata: 
  node_type: memory
  type: project
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

User decision 2026-07-12: fix group-onboarding UX as the stage after [[auto-permission-mode-direction]] ships.

Live incident: user created Telegram group "Hermes Agent Buildathon" (-1003798366047, forum), added bot Kai (@ravi_clawbot, privacy off), made it admin — total silence. Root cause: unregistered-chat messages dropped at debug level (channel-connect.ts ~634); join events discarded; no product path could bootstrap the group.

Scope (task #10 in session task list):
1. Bot-added/join event → durable one-tap operator DM ("respond in '<group>'? Yes/No") that registers conversation + agent install + approver via the reviewed settings path (reuse pending-interaction machinery).
2. INFO-log unregistered-chat drops with chat id.
3. `gantry conversation install`: bootstrap-from-jid (today requires the conversation row that only registration creates — chicken-and-egg), normalize ids like `conversation info` does, include control_approvers in generated entry.
4. `gantry settings export` crash (reading 'installedAgents').
5. `settings import` must report outcome (revision N / applied-no-revision / no-op) and print in non-TTY.

**What works today (the workaround)**: edit ~/gantry/settings.yaml directly; the runtime's settings-reload-watcher auto-imports it as a revision (created_by settings.yaml:auto-import) and reconciles. Canonical conversation key form: `<providerAccount>_<chatId>_<hash>` (hash surfaces only in validation errors). Registration needs: conversations entry (provider_account, id, type channel, sender_policy, control_approvers, installed_agents) + restart if reconcile says restartRequired.
