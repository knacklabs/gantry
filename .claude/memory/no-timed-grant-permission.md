---
name: no-timed-grant-permission
description: "User decision — the \"Allow 5 min\" (allow_timed_grant) permission option is removed altogether; prompts offer only Allow once / Allow for future / Deny"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 968040bb-9312-4913-b84e-c735654be245
---

The "Allow 5 min" permission button (`allow_timed_grant` decision mode) is
REMOVED by user decision (2026-07-13) — single cut, mode + machinery (buttons,
channel handlers, runner timed-window gate, expiry, contracts). Permission
prompts offer only: Allow once, Allow for future (allow_persistent_rule when a
persistent suggestion exists), Deny.

**Why:** the timed grant was noise in the prompt and the durable path is the
Allow-for-future flywheel; the decision predated the auto-permission goal
prompt, which never covered it, so it survived until explicitly removed.

**How to apply:** never reintroduce a timed/windowed grant option in prompt
button sets or suggest one in permission UX work; stale `perm:allow_timed_grant`
callbacks must fail safely as invalid/expired. Related:
[[auto-permission-trust-pause]], [[notification-ux-redesign]].
