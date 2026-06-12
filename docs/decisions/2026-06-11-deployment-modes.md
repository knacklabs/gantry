# 2026-06-11 — Deployment Modes

## Context

Gantry is one binary with one canonical runtime model
([personal-and-enterprise-modes.md](../architecture/personal-and-enterprise-modes.md)).
Operators need to deploy it three ways without forking the runtime: a single
workstation, a horizontally scaled fleet on AWS, and a locked internet-facing
support stack. The driver for horizontal scale is **load + availability**
(confirmed by user, CEO plan premise P1): a single machine cannot absorb fleet
live-chat and job throughput, and a single machine has no failover.

A naming collision exists and must be recorded. An environment variable
`GANTRY_DEPLOYMENT_MODE` **already exists** and means `production|remote`
**security posture**, consumed in
`apps/core/src/shared/security-posture.ts:34`, threaded through
`apps/core/src/config/index.ts:43`, `apps/core/src/runtime/ipc-auth.ts:21`, and
`apps/core/src/control/server/index.ts:206-227`. The new concept introduced here
is **topology** (one machine vs many), which is a different axis. We must not
overload one variable across two axes.

The word "profile" is reserved: it already names agent persona/profile tools
(`agent_profile_read`, `request_agent_profile_update`). Topology must not reuse
it.

## Decision

1. Deployment topology is a `settings.yaml` runtime key:
   `runtime.deployment_mode: workstation | fleet`. It is **not** named
   "profile".
   - `workstation` — today's behavior, zero regression. Single machine, vertical
     scale, live skill/dependency installs, `settings.yaml` + file watcher. Maps
     onto **personal mode** in
     [personal-and-enterprise-modes.md](../architecture/personal-and-enterprise-modes.md).
   - `fleet` — N immutable workers behind an ALB against RDS + S3. Capability
     state is data, not host mutation; configuration is managed through
     desired-state control-API endpoints. Maps onto **enterprise mode**.

2. Topology and security posture are **two independent axes**.
   - Topology = `runtime.deployment_mode` (`workstation|fleet`), settings key,
     introduced here.
   - Security posture = the existing env var, values `production|remote`,
     unchanged in semantics.
   - The env var `GANTRY_DEPLOYMENT_MODE` will be **renamed to
     `GANTRY_SECURITY_POSTURE`** (identical values and semantics) in Phase 3 when
     the settings key lands. Gantry is early-stage with no live users, so we take
     the clean cut rather than carry a compatibility shim
     (AGENTS.md "prefer deleting legacy code over compatibility shims";
     consistent with the clean-cutover policy in
     [2026-04-21-storage-backend-cutover.md](./2026-04-21-storage-backend-cutover.md)).

3. The axes **compose**:
   - `fleet` **requires** production security posture
     (`GANTRY_SECURITY_POSTURE=production`). Fleet boot fails readiness if the
     posture is not production.
   - `workstation` defaults to the relaxed local posture but **may** opt into
     production posture.

4. Fleet v1 live topology is **1 live-host worker + N job workers**
   (heterogeneous pool). The singleton live-host lease
   `runtime:live-turn-host:default` (`apps/core/src/app/bootstrap/live-recovery-coordinator.ts:9`)
   **stays**. The current boot behavior throws when the lease is contended;
   Phase 2 changes boot to **retry-with-backoff** so a rolling deploy does not
   crash-loop the incoming live host. Job workers run scheduler-only
   (`runtime.live_turns.enabled: false`) as documented in
   [multi-worker-execution.md](../architecture/multi-worker-execution.md).
   Live-host failover RTO = lease TTL (~30s).

   > **Superseded (2026-06-12).** The singleton live-host lease is gone and live
   > execution is now horizontally distributed across process roles
   > (`control`/`live-worker`/`job-worker`). See
   > [2026-06-12 — Process Roles and Multi-Live](./2026-06-12-process-roles-and-multi-live.md).

5. The **Phase-4 multi-live GroupQueue cutover is explicitly out of scope** for
   this plan. It is revisited only when one of these criteria is met:
   - live-turn throughput on a single live host saturates (one host can no longer
     admit the offered live-turn rate), or
   - an availability requirement sets failover RTO **below** the live-turn lease
     TTL.
     Until then the singleton live host is the accepted v1 ceiling (user-accepted,
     CEO plan T2).

   > **Superseded (2026-06-12).** The multi-live cutover shipped by product
   > decision, ahead of these saturation/RTO triggers. See
   > [2026-06-12 — Process Roles and Multi-Live](./2026-06-12-process-roles-and-multi-live.md).

## Alternatives Considered

- **Overload the existing `GANTRY_DEPLOYMENT_MODE` to also carry topology**
  (`production|remote|fleet`): rejected. Posture and topology are orthogonal — a
  workstation can run production posture, and fleet always runs production
  posture. Collapsing them produces undefined combinations and couples a security
  control to a scaling decision.
- **Name the key `runtime.profile`**: rejected. Collides with agent
  persona/profile tooling; "profile" already has a meaning in the agent surface.
- **Separate personal/enterprise runtime paths**: rejected by the standing
  architecture rule — both modes exercise the same application and domain
  contracts
  ([personal-and-enterprise-modes.md](../architecture/personal-and-enterprise-modes.md)).
- **Build multi-live now**: rejected (user-accepted). The singleton lease already
  exists and is correct; the GroupQueue cutover has no consumer until the
  single-host ceiling is hit.

## Consequences

- A new `runtime.deployment_mode` setting selects mode defaults for capability
  installs (ADR-2), settings authority (ADR-3), and live topology.
- The env-var rename to `GANTRY_SECURITY_POSTURE` **landed in Phase 3**
  (implemented) as a clean cut with no compatibility shim:
  `GANTRY_DEPLOYMENT_MODE` no longer exists in the codebase. Topology is the
  `runtime.deployment_mode` settings key.
- Fleet readiness gates on production posture; mismatched posture is an operator
  error with a clear remediation, surfaced through `/readyz`.
- Operator-facing mode behavior, the state-ownership table, and the upgrade/skew
  matrix live in
  [deployment-profiles.md](../architecture/deployment-profiles.md).

## Rollback Or Migration Notes

- No data migration. `runtime.deployment_mode` defaults to `workstation`, so
  existing single-node deployments are unaffected.
- Reverting fleet to workstation is a configuration change plus teardown of the
  fleet infrastructure (ADR-5); no schema rollback is required because capability
  artifacts and settings revisions are additive.

## See Also

- [2026-06-11 — Capability Artifacts](./2026-06-11-capability-artifacts.md)
- [2026-06-11 — Settings Authority](./2026-06-11-settings-authority.md)
- [2026-06-11 — Locked Preset](./2026-06-11-locked-preset.md)
- [2026-06-11 — Delivery Vehicle](./2026-06-11-delivery-vehicle.md)
- [deployment-profiles.md](../architecture/deployment-profiles.md)
