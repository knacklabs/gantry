---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-28
---

# Serialize the file-is-the-store settings write

## Context

`writeDesiredRuntimeSettings` (`apps/core/src/config/settings/desired-settings-writer.ts:75-84`)
has two paths. When a storage provider is configured it appends a durable
`settings_revisions` row. When one is **not** configured it reads the current
settings, classifies the change, and calls `saveRuntimeSettings` — an **unlocked
read-modify-write**. Two concurrent writers on that path each read the same base and
the second write silently drops the first's update. There is no lock and no version
check. That lost-update window is RACE-9.

The provider is a module-global set at two entry points: the CLI
(`apps/core/src/cli/index.ts:34`, at module load) and the control server
(`apps/core/src/control/server/index.ts:281`, during startup).

### The no-provider path is a supported mode, not dead weight

An earlier draft of this decision proposed **deleting** the fallback and throwing,
on the assumption that both real entry points always configure a provider so the
path was unreachable. That was wrong, and the codebase says so explicitly
(`apps/core/src/cli/group-helpers.ts:264-270`):

> *"Without a provider the file IS the store, and a file write is correct.
> `reconciled: false` is therefore not an error condition; a genuine failure
> surfaces as a throw and is caught below."*

So `reconciled: false` is a deliberate signal that the write landed in the file with
no database projection to reconcile, and production branches on it
(`cli/group.ts:513`, `cli/group-remove-routeless.ts:98`, `cli/group-helpers.ts:279`).
Attempting the deletion made **35 tests across 9 CLI/control files** fail, several of
which assert behaviour that depends on `reconciled: false` — they were not merely
unconfigured, they were exercising the mode on purpose. Deleting the path would have
removed a documented behaviour and collapsed a result-shape distinction the CLI
relies on.

## Decision

**Keep the file-is-the-store path and make it safe.** Serialize the
read-modify-write so two concurrent writers cannot lose an update:

1. Serialize per settings file (keyed on the resolved `settings.yaml` path) so the
   read → classify → save sequence cannot interleave with another writer's.
2. Read the base **inside** the serialized section, and **rebase the caller's delta
   onto it**. Serialization alone is not sufficient: each caller passes a *full*
   settings snapshot built from its own earlier read, so a serialized second write
   would still overwrite the first writer's key. Instead compute the delta between
   the caller's `previousSettings` and its `settings`, and apply only that delta to
   the freshly-read current file (`applySettingsSnapshotDelta`) — a three-way merge
   that preserves concurrent changes to untouched keys while still honouring keys the
   caller intentionally **deleted**.
3. Leave the return contract untouched — `reconciled: false` still means "written to
   the file, nothing to reconcile" — and leave the provider-configured path exactly
   as it is.

   *Semantic note:* a caller's snapshot no longer wins wholesale; only its delta
   applies. That is the point — wholesale wins are exactly how the update was lost —
   but it is a real behaviour change for a caller that expected to overwrite keys it
   never intended to touch.

### Rejected alternative

**Delete the fallback and throw** (an earlier accepted draft of this decision, now
superseded). Rejected because the path is a documented supported mode: the file is
the authority when no provider is configured, `reconciled: false` is load-bearing
for CLI projection cleanup, and removing it broke 35 tests that deliberately exercise
it. The correction is recorded here rather than silently dropped, because the wrong
premise ("dead weight") is what made deletion look attractive.

## Consequences

- **Touched:** `apps/core/src/config/settings/desired-settings-writer.ts` (serialize
  the no-provider write) and its unit tests. No change to the CLI, the control
  server, the provider-configured path, or the `reconciled` contract.
- **Behavior:** unchanged for every caller except that concurrent no-provider writes
  now queue instead of racing. No new failure mode, no new error.
- **Scope of the guarantee:** in-process serialization. Cross-process contention on
  one `settings.yaml` (for example a CLI command while the runtime is writing) is
  **not** covered — that would need file locking, and it is out of scope here because
  the CLI and control server both configure a provider and so do not use this path.
- Closes RACE-9, the last of the audit's latent items.
