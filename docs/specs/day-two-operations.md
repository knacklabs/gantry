---
slug: day-two-operations
title: Day-two operations: bootstrap, incident controls, alerts, backup and upgrade, data lifecycle, revisions
status: confirmed
saved: 2026-08-27T08:49:10+00:00
---



# Day-two operations: bootstrap, incident controls, alerts, backup and upgrade, data lifecycle, revisions

## Capability

An IT owner can stand up a fresh install as an organisation, stop everything in one
audited command at 2am even when the console is down, be told in one place when
something needs them, back up, restore, upgrade and roll back the install, set
retention and erase or decommission data on request, and restore any persona or
access change to a prior revision. This is the operation of the product, not the
product; the first client judges the engagement on it in week one.

## Why

The roadmap review of 2026-08-27 found the stories build the product but not its
operation: "Pause everywhere" pauses jobs only; administrators receive no alerts
until V1.1; there is no backup, restore, or rollback path; retention and deletion
cover verified people only; revisions exist but cannot be restored; a fresh install
seeds a personal app and has no tested first-administrator journey.

## Behaviour

### Bootstrap (V1.0)

A fresh install creates an organisation app named at setup (not the seeded personal
app); a local one-time administrator link leads to IdP configuration and the first
real administrator in one tested journey; initial secrets are ingested once and
referenced thereafter; break-glass CLI grant is documented.

### Incident controls (V1.0)

`freeze` / `unfreeze` stop new runs for every agent atomically with durable
cancellation intent, audited, administrator-only, from the CLI with no console or
IdP. Per-agent and per-conversation pause are explicit states with in-flight
semantics; approvers can pause an agent from the channel card; a paused or frozen
agent replies with a fixed, configurable line. `freeze` is soft by default (no new
runs or tool calls; in-flight turns finish) and `--hard` cancels immediately.

### Admin alerts (V1.0)

One configured admin conversation per deployment, fed by the durable delivery path
with de-duplication, for a named event list: approvals unanswered, handoffs
unclaimed, OAuth expired, endpoints unreachable, repeated run failures,
freeze/unfreeze, offboarding, self-revisions applied. Other stories reuse it. The V1.0 sink is one Teams or Slack conversation; email
and webhook sinks come later.

### Backup, upgrade, rollback (V1.0)

Scripted backup/restore drill tested in CI, targeting an S3-compatible bucket or a
local path at the operator's choice (secret references, never values); upgrade with pre-flight migration check,
release notes per tag, pinned image digest and a rollback command (decision 0147).

### Data lifecycle (V1.0.x)

Retention per class with holds (defaults: messages 90 days, memory until
offboarding, audit 400 days minimum); `conversation erase` for anonymous callers;
`deployment decommission` exporting the tenant audit hash-stamped, wiping, and
producing a deletion certificate (decision 0148).

### Revision restore (V1.0.x)

Persona and access are revisioned documents with author, diff, audit row; restore
appends a CAS-fenced corrective revision from the detail page or CLI — owners for
persona, administrators (with re-authentication) for access.

### Support (V1.1)

Redacted diagnostics bundle, release notes, support policy.

## Acceptance criteria

- **BOOTSTRAP-1** — Org bootstrap: first administrator, org app, initial secrets
  - Fresh install seeds an organisation app (not the personal Default Local App) named at setup; the deployment-app identity decision is recorded
  - Local one-time admin link → configure IdP → first real administrator is one tested journey; invitations work from the bootstrap admin
  - Initial provider secrets are ingested once via CLI or the write-only facade (decision 0143) and referenced thereafter; break-glass CLI grant documented
- **INCIDENT-1** — Incident controls: freeze, real pause, paused replies
  - gantry freeze / unfreeze stops new runs for all agents atomically with durable cancellation intent; audited; administrator-only; works from the CLI without console or IdP
  - Per-agent pause and per-conversation pause are explicit states with in-flight semantics; HANDOFF-1's conversation pause uses this state; approvers can pause an agent from the channel card
  - A paused or frozen agent replies to messages with a fixed, configurable line and posts nothing else
  - freeze is soft by default (no new runs or tool calls; in-flight turns finish); --hard cancels immediately; both audited
- **ADMIN-ALERT-1** — Admin notifications: one channel, named events
  - One configured admin conversation per deployment; delivery through the durable jobs/delivery path with de-duplication per event and threshold
  - Named event list in settings: approval unanswered > N min, handoff unclaimed > N min, OAuth expired or unhealthy, provider endpoint unreachable, N consecutive run failures, freeze/unfreeze, offboarding, self-revision applied
  - COST-2 and SELF-1 reuse this channel
  - V1.0 sink is one Teams or Slack conversation; email/webhook sinks are later
- **OPS-DR-1** — Day-two operations: backup, restore, upgrade, rollback
  - Documented and scripted backup/restore drill covering Postgres and secret-provider references; restore tested in CI against a fresh install
  - Upgrade path: pre-flight migration check, release notes per tag, pinned image digest with a rollback command
  - Decision amending 0003 for tagged releases recorded; secret rotation for provider/connector references documented
  - Backup target is an S3-compatible bucket or a local path, operator's choice; secret references are backed up, never secret values
- **LIFECYCLE-1** — Data lifecycle: retention, anonymous erase, decommission
  - Retention policy in settings per class (messages, memory, audit) with holds; purge is audited
  - gantry conversation erase <id> redacts an anonymous caller's thread (WhatsApp, voice) irreversibly
  - gantry deployment decommission: offboard every principal, export tenant audit (hash-stamped), wipe; deletion certificate produced
  - Defaults when unset: messages 90 days, memory until offboarding, audit 400 days minimum; stated in SECURITY
- **REVISION-1** — Revision restore: persona and access rollback
  - Persona/profile is a revisioned desired-state document; every edit is a revision with author PrincipalRef, diff, and audit row
  - Restore appends a CAS-fenced corrective revision (no destructive rollback); available from the agent detail and CLI
  - Access revisions (ACCESS-UI-1) use the same restore
  - Owner may restore persona revisions; administrator (with reauth) may restore access revisions
- **SUPPORT-1** — Support bundle and release notes
  - gantry support bundle (redacted logs, config, versions); release notes per tag; support policy doc (community vs engagement)

## Source

Roadmap review 2026-08-27 (Fable and Codex, docs/architecture/ai-employee-v1-gap-analysis.md Part 3); decisions 0147, 0148. Stories: BOOTSTRAP-1, INCIDENT-1, ADMIN-ALERT-1, OPS-DR-1, LIFECYCLE-1, REVISION-1, SUPPORT-1.
