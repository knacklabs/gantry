# 2026-06-11 — Settings Authority Per Deployment Mode

## Context

[2026-04-17 — Settings And Runtime Truth](./2026-04-17-settings-runtime-truth.md)
established `settings.yaml` as the canonical desired-state surface, watched live
and mutated by CLI and reviewed admin tools. That contract is correct for a
single host. It does not work for a `fleet`
([2026-06-11-deployment-modes.md](./2026-06-11-deployment-modes.md)): N immutable
workers cannot each own and watch a local file, and a future fleet management UI
needs a desired-state API, not file edits.

The user resolved this with gate revision 2 (CEO plan adopted revision 2): **one
desired-state service, two surfaces** — keep YAML for workstation, add a
control-API desired-state surface for fleet, with **one mutation path and one
validation**. No authority fork.

## Decision

1. **One desired-state service, two surfaces.**
   - **Workstation:** `settings.yaml` watcher becomes an **auto-importer**. A
     valid file change is imported through the same desired-state service.
   - **Fleet/org:** **control-API desired-state CRUD endpoints** are the mutation
     surface. A future management UI builds on these endpoints — the **UI is out
     of scope, the API is in scope** for this plan. `settings.yaml`
     import/export remains as bootstrap/backup tooling on fleet (explicit CLI
     import only; the file is **not** watched in fleet mode).

2. **Same validation both ways.** Both surfaces run identical schema validation
   and produce identical path-level errors. There is no second validation lane
   and no second authority model.

3. **Revisioned distribution with a skew contract.** Desired state is versioned
   in a `settings_revisions` table carrying a **`min_reader_version`**. A worker
   whose code is older than a revision's `min_reader_version` **holds its
   last-applied revision and alerts** rather than mis-applying state it cannot
   parse. This is the skew safety contract for rolling deploys.

4. **Wake-up + fallback.** Revision changes wake workers via **`pg_notify`**;
   a **poll fallback** guarantees convergence if a NOTIFY is dropped. (This reuses
   the existing pg_notify-with-reconnect path noted in the plan's reuse points.)

5. **First boot with no revision** is a red `/readyz` with a log line naming the
   seed command, not a crash.

## Supersedes (Fleet Mode Only)

This ADR supersedes the following clauses of
[2026-04-17 — Settings And Runtime Truth](./2026-04-17-settings-runtime-truth.md)
**for `fleet` mode only**. **Workstation behavior is unchanged** — every clause
below still holds as written for workstation.

- **Clause 2** (`settings.yaml` is the canonical runtime behavior surface):
  superseded for fleet — the canonical surface in fleet is the desired-state
  service fronted by the control API; `settings.yaml` is bootstrap/backup tooling.
- **Consequence "Runtime watches `settings.yaml`; valid safe changes reconcile
  live"**: superseded for fleet — the watcher is disabled as a watcher; import
  runs only on explicit CLI invocation. Distribution to workers is via
  `settings_revisions` + pg_notify, not a file watch.
- **Consequence "CLI mutation commands update `settings.yaml`"**: in fleet, CLI
  and API mutations go through the desired-state service and produce a revision;
  the YAML file is no longer the source of truth that workers read.

Everything else in 2026-04-17 (secret/`.env` boundary, `model_access.*` scope,
agent/conversation key ownership, additive reconciliation, reviewed admin-tool
mediation) is **unchanged in both modes**.

## Alternatives Considered

- **YAML everywhere, including fleet** (workers share one file via a mounted
  volume): rejected (superseded by user gate revision 2). A shared file across N
  immutable workers has no revision/skew contract, no clean multi-writer story,
  and no UI backend.
- **A separate fleet-only settings authority** with its own validation: rejected
  by the user's "one mutation path, no authority fork" decision. Two validators
  drift; two authority models double the security surface.
- **API-only, drop YAML entirely**: rejected. Workstation users keep the file as
  a first-class, diffable, version-controllable surface; export remains valuable
  as fleet backup/bootstrap.

## Consequences

- Workstation operators see no change: edit `settings.yaml`, it reconciles live.
- Fleet operators mutate desired state through the control API (and seed/back up
  via `settings import`/`settings export`); workers converge via
  revision + NOTIFY + poll.
- The `settings_revisions.min_reader_version` contract makes mixed-version
  rolling deploys safe; the upgrade/skew matrix in
  [deployment-profiles.md](../architecture/deployment-profiles.md) enumerates the
  "old worker + new revision" and "new worker + old revision" cases.
- A management UI can be built later directly on the control-API endpoints with no
  further authority work.

## Rollback Or Migration Notes

- `settings_revisions` is an additive migration; workstation deployments that
  never write a revision are unaffected.
- Reverting a bad fleet revision is writing a corrected revision (additive); there
  is no destructive rollback.
- Switching a deployment from fleet back to workstation re-enables the file
  watcher; `settings export` reproduces a `settings.yaml` from current desired
  state.

## See Also

- [2026-04-17 — Settings And Runtime Truth](./2026-04-17-settings-runtime-truth.md)
  (superseded for fleet mode by this ADR)
- [2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md)
- [2026-06-11 — Capability Artifacts](./2026-06-11-capability-artifacts.md)
- [deployment-profiles.md](../architecture/deployment-profiles.md)
