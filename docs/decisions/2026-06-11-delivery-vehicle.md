# 2026-06-11 — Delivery Vehicle

## Context

A `fleet` deployment ([2026-06-11-deployment-modes.md](./2026-06-11-deployment-modes.md))
needs a concrete, reproducible way to stand up infrastructure: container image,
database, object storage, scaling, and ingress. The user decided the delivery
vehicle is **Terraform/AWS-first** (CEO plan premise P4, gate decision T3; the
challenge dissolved when the Codex DX voice also endorsed Terraform-first). Helm,
GCP, and Azure are deferred.

The plan also fixes operational details that the delivery vehicle must encode:
migrations ship inside the image, migration must be race-safe across a rolling
deploy, and S3 access is split by role (bake vs worker).

## Decision

1. **Terraform/AWS-first.** The shipped delivery vehicle is Terraform targeting
   AWS. **Helm/K8s, GCP, and Azure are deferred** (TODOS.md). Module **interfaces
   stay cloud-neutral** so a future provider module set can slot in without
   reworking callers.

2. **Multi-stage Docker image; migrations in the image.** A multi-stage build
   (pinned Node runtime) produces the runtime image. Database migrations are
   **baked into the image**, not run from an operator workstation.

3. **Race-safe migration entrypoint.** The container entrypoint takes a **pg
   advisory lock** before migrating, so concurrent boots in a rolling deploy do
   not race migrations. Migrations are **additive-only**; the migration DB role is
   distinct from the runtime role. On contention the loser waits; on failure the
   entrypoint exits non-zero.

4. **ASG + lifecycle hooks.** Workers run in an Auto Scaling Group wired to
   **lifecycle hooks** that drive graceful drain (SIGTERM → stop claiming → finish
   or hand off live turns → bounded deadline → exit), so rolling updates do not
   drop in-flight work.

5. **RDS + RDS Proxy.** Postgres is RDS (with pgvector); connections go through
   **RDS Proxy** to bound connection count under a scaling worker fleet.

6. **S3 with split IAM.** One bucket layout (`skills/`, `toolchains/`) with
   **split IAM**: the **bake role has read-write**, **workers have read-only**
   (ADR-2 — workers never mutate capability state; the bake job is the only
   writer).

## Alternatives Considered

- **Helm chart / Kubernetes operator first**: deferred (user; pending gate U1).
  Terraform-first matched the user's operational target and was endorsed by the
  Codex DX voice. K8s remains a future delivery vehicle behind the cloud-neutral
  module interfaces.
- **GCP / Azure module sets first**: deferred (CEO plan scope decision #4,
  AWS-first per user). Interfaces stay cloud-neutral to keep them cheap to add.
- **Run migrations from an operator workstation / CI step instead of the image**:
  rejected. Image-resident migrations keep the migrating code and the migration in
  lockstep and remove an out-of-band step from the runbook.
- **Single shared S3 IAM role for bake and workers**: rejected. Workers must be
  read-only so a compromised worker cannot rewrite capability artifacts; the
  split-IAM boundary enforces ADR-2's "workers never mutate" guarantee.
- **Direct RDS connections without a proxy**: rejected. A scaling worker fleet
  would exhaust the connection budget; RDS Proxy bounds it.

## Consequences

- Phase 2 ships the Dockerfile, entrypoint, and AWS Terraform modules (network,
  database, storage, secrets-as-refs, worker_pool, control) plus `envs/fleet` and
  `envs/support`; the locked support stack is `terraform apply
  -var-file=support.tfvars` (ADR-4).
- The advisory-lock entrypoint makes mixed-version rolling deploys migration-safe;
  the upgrade/skew matrix in
  [deployment-profiles.md](../architecture/deployment-profiles.md) covers the
  "migration vs old worker" case.
- Split IAM is the infrastructure enforcement of ADR-2's worker-immutability
  contract.
- The operator runbook lives at `docs/deployment/aws-terraform.md` (created in
  Phase 2); [deployment-profiles.md](../architecture/deployment-profiles.md)
  indexes it.

## Rollback Or Migration Notes

- Infrastructure rollback is Terraform: re-apply a prior configuration or destroy
  the stack; Terraform state lives in S3 + DynamoDB with no secret values in
  state.
- Because migrations are additive-only, rolling an image back does not require a
  down migration; an older image runs against a newer additive schema.
- Teardown is `terraform destroy` against the relevant env; capability artifacts
  in S3 and revisions in RDS are destroyed with the stack.

## See Also

- [2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md)
- [2026-06-11 — Capability Artifacts](./2026-06-11-capability-artifacts.md)
- [2026-06-11 — Locked Preset](./2026-06-11-locked-preset.md)
- [deployment-profiles.md](../architecture/deployment-profiles.md)
- `docs/deployment/aws-terraform.md` (Phase 2)
