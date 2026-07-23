---
name: auto-permission-trust-pause
description: "RESOLVED: action-based auto-permission rework shipped as PR #212; merge held pending manual smoke (lead-gen job + Telegram auto-mode check)"
metadata:
  node_type: memory
  type: project
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

The run-origin trust-anchor pause was resolved by the action-based rework
(2026-07-13): Stages A–C of
docs/architecture/auto-permission-action-based-goal-prompt.md landed on
`feature/auto-permission-mode` (commits `7c04233d0` A+B, `ac169b09b` docs) and
shipped as PR #212 (github.com/knacklabs-ai/gantry/pull/212). All run-origin
machinery, `attended`/`trustedRequester`/`resolvePermissionAuthority`, and the
responseKeyId-derived trust were removed (drop migration 0101); responseKeyId
IPC signing kept. Stage D stash was dropped by the user.

State: branch pushed, branch-wide xhigh autoreview CLEAN, verify.py green,
5934 unit tests pass, offline haiku eval 25/25, drop migration applied to the
dev DB via service restart. **Merge held** until manual smoke: `gantry jobs
trigger job-knacklabs-lead-maintenance-43527c192a6e` to success + Telegram
auto-mode spot check (provable read silent, write prompts admin).

Design notes that survived five xhigh review rounds: git is fully OUT of the
silent set (core.fsmonitor executes repo config on `git status`; .git/config is
agent-writable); silent cat/ls requires realpath containment in the workspace
(hidden/secret checks on the workspace-relative part so a dotted GANTRY_HOME
works); SECRET_KEY wins over id/name/ref suffixes with an exact
BENIGN_SELECTOR_KEYS allowlist (credential_profile_ref); MCP silent reads need
reviewed semantic-capability read bindings, not name-derived matches. A round-5
reviewer push to re-add requester identity was rejected as re-litigating the
locked decision — the rationale is documented in capability-management.md.
Related: [[auto-permission-mode-direction]], [[group-onboarding-ux-fix]] (now
unblocked), [[autoreview-local-before-commit]].
