# 2026-06-11 — Capability State As Artifacts

## Context

In `workstation` mode, skills and their dependencies are installed live on the
host: a package manager runs, files land on disk, the runtime picks them up. In
`fleet` mode ([2026-06-11-deployment-modes.md](./2026-06-11-deployment-modes.md))
workers are immutable and may be replaced at any time by the ASG. A worker that
mutates itself (runs `npm install`, writes a skill into its own filesystem) is no
longer reproducible, cannot be trusted to match its image digest, and diverges
from its peers. Capability state must therefore be **data**, not a side effect on
a worker host.

The user has made a binding decision on scope: skills and toolchains are
**current-state, replace-on-update — no versioned store, no migration, no GC**
(CEO plan gate revision 1). This ADR records that decision and the artifact +
bake-job model that follows from it.

## Decision

1. **Skills and toolchains are current-state S3 artifacts.** S3 mirrors the
   existing `skills/<name>/` layout. Update = replace the artifact in place. There
   is **no versioned artifact store, no migration path, and no garbage
   collection** (explicit user decision). Provenance stays in audit events, not
   in a version lane.

2. **Integrity is verified, not assumed.** Change detection and integrity reuse
   the existing `contentHash` column
   (`apps/core/src/adapters/storage/postgres/schema/skills.ts:38`). On
   materialize, a worker performs a **sha256 verify** against the recorded hash
   and an **atomic temp-write + rename** swap so a partially fetched artifact is
   never activated. A hash mismatch quarantines the artifact and alerts (the
   capability is simply not advertised; remediation:
   `gantry artifacts quarantine rebake`).

3. **No package manager ever runs on a fleet worker.** Dependencies are produced
   by a **sandboxed bake job**, not reconciled at runtime. The bake job:
   - runs **lockfile-pinned npm**,
   - runs with `--ignore-scripts` **by default**, with a **native-module
     allowlist** for the cases that genuinely need build scripts,
   - uses an **allowlisted registry** and is **egress-restricted**,
   - produces a toolchain artifact that workers fetch, verify, and atomically
     activate.

4. **npm-only.** The fleet manifest is npm/Node runtime only. **System packages
   are rejected with an explicit error** that names image bake as the supported
   path (system dependencies belong in the worker image, not in a runtime
   artifact). The error is an operator-actionable message, not a silent failure.

5. **Worker dispatch advertises what it can satisfy.** A worker activates an
   artifact, then advertises the capability in
   `worker_instances.capabilities_json`; work routes only to workers that can run
   it. (Dispatch eligibility mechanics are Phase 3; this ADR fixes the artifact
   contract they build on.)

## Alternatives Considered

- **Per-worker runtime npm reconciler** (each worker runs `npm install` to
  converge on a desired dependency set): rejected. It mutates immutable workers,
  breaks image-digest reproducibility, and makes two workers with the same image
  behave differently. Replaced by the sandboxed bake job (CEO plan adopted
  revision 1; found independently by both CEO voices).
- **Versioned artifact store** (keep every prior version, migrate on read):
  rejected by the user as overcomplicated for an early-stage product with no live
  fleet users. Current-state replace-on-update is sufficient; rollback is
  re-baking the prior manifest, not reading an old version.
- **Garbage collection of superseded artifacts**: out of scope (user). Storage is
  cheap relative to the complexity of a correct GC under concurrent
  fetch/activate.
- **Allow system packages in the runtime manifest**: rejected. System packages
  cannot be installed safely or reproducibly on a running immutable worker; they
  belong in the image bake.

## Consequences

- A fleet worker never runs a package manager; the only mutation path for
  capability state is "fetch artifact → verify sha256 → atomic activate".
- The bake job is a privileged, sandboxed subsystem (Phase 3); workers hold
  read-only S3 access and the bake role holds read-write (split IAM, ADR-5).
- Replace-on-update means an in-flight worker may briefly hold the prior artifact
  until it reconciles; the upgrade/skew matrix in
  [deployment-profiles.md](../architecture/deployment-profiles.md) covers the
  "bake artifact vs old worker" skew case.
- Workstation mode is unchanged: live installs continue exactly as today. The
  artifact + bake model applies to `fleet` only.

## Rollback Or Migration Notes

- No migration of existing skill state; S3 mirrors the current `skills/<name>/`
  layout, so the on-disk shape is already the artifact shape.
- "Rollback" of a bad update is re-baking and re-uploading the prior manifest —
  there is no version to revert to by design.
- Quarantined artifacts are purged or re-baked via
  `gantry artifacts quarantine purge|rebake`; no automatic cleanup runs.

## See Also

- [2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md)
- [2026-06-11 — Settings Authority](./2026-06-11-settings-authority.md)
- [2026-06-11 — Delivery Vehicle](./2026-06-11-delivery-vehicle.md)
- [deployment-profiles.md](../architecture/deployment-profiles.md)
