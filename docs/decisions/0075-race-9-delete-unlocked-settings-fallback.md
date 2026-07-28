---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-28
---

# Delete the unlocked no-store settings write fallback

## Context

`writeDesiredRuntimeSettings` (`apps/core/src/config/settings/desired-settings-writer.ts:73-84`)
has two paths. When a storage provider is configured it appends a durable
`settings_revisions` row. When one is **not** configured it silently falls back to
an unlocked read-modify-write: read the current settings, classify the change, then
`saveRuntimeSettings`. Two concurrent writers on that path each read the same base
and the second write drops the first's update. There is no lock and no version
check.

The provider is a **module-global** (`storageProvider`) set as a side effect of
startup, in exactly two places:

- `apps/core/src/cli/index.ts:34` — at module load, so every CLI command has it;
- `apps/core/src/control/server/index.ts:281` — during control-server startup.

Client context (2026-07-28): those are the only real entry points — a personal
runtime is driven through the **CLI**, and an organisation drives it through the
**SDK/API**, i.e. the control server. Both configure the provider, and both files
change rarely. So the fallback is not a path anyone actually needs; it is dead
weight that happens to contain a lost-update race.

The audit classified this as latent (the primary Postgres production path is
unaffected) and recommended either removing the fallback from production wiring or
adding file locking with versioned compare-and-swap.

## Decision

**Delete the fallback and fail loudly.** When no storage provider is configured,
`writeDesiredRuntimeSettings` throws instead of writing settings unlocked — the
same shape as the error already raised a few lines below when the provider yields
no storage (*"Settings mutation requires runtime storage so settings_revisions can
be durably appended."*). A settings write with nowhere durable to record it is a
programming error, not a mode to support.

Per the no-backward-compatibility policy there is no shim and no deprecation
window. This follows RACE-8's precedent: the unsafe path stops existing rather than
being made "safe enough", so the requirement is explicit at the call site instead
of degrading silently.

### Rejected alternatives

- **Serialize the fallback** (in-process mutex or file lock). Rejected: it keeps a
  second, weaker write path alive forever and only helps single-process contention,
  while the durable revision record — the actual authority — is still skipped.
- **Re-order startup so the provider is configured earlier, then delete.** Rejected
  as unnecessary: both real entry points already configure it before any settings
  write, so no ordering change is required. Avoiding a boot-ordering change also
  avoids the failure mode where settings writes begin throwing during startup.

## Consequences

- **Touched:** `apps/core/src/config/settings/desired-settings-writer.ts` (fallback
  branch deleted, throw added) and its unit tests. No change to the CLI, the
  control server, or the Postgres path.
- **Behavior change:** a caller that writes settings without a configured provider
  now gets a clear error instead of a silent unlocked write. That is the point.
- **Verification bar:** because this touches the settings write path, it is verified
  by the full suite **and** a real deploy plus smoke (`gantry restart`, then confirm
  settings reads/writes still work) before being called safe.
- Any embedder or test that relied on the implicit no-store path must configure a
  provider explicitly — visible as a thrown error, not a silent race.
- Closes RACE-9, the last of the audit's latent items.
