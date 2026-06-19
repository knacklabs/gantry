# Gantry on AWS — Terraform Runbook

Copy-paste runbook for standing up a Gantry **fleet** or **locked support** stack
on AWS with Terraform, plus a short local-rehearsal section.

Targets (measured gates from the deployment-modes plan):

- **Local fleet rehearsal → first conversation: ≤ 15 min.**
- **Clean AWS account → first locked support-agent turn: ≤ 60 min.**

Background: [deployment-profiles.md](../architecture/deployment-profiles.md) and the
ADRs under [docs/decisions/](../decisions/) (delivery vehicle, deployment modes,
[process roles and multi-live](../decisions/2026-06-12-process-roles-and-multi-live.md),
capability artifacts, locked preset).

Module reference: `ops/terraform/modules/{network,database,storage,secrets,worker_pool,control}`,
roots `ops/terraform/envs/{fleet,support}`. Image: `ops/docker/Dockerfile` +
`ops/docker/entrypoint.sh`.

Artifact bucket IAM is split by prefix. Capability artifacts (`skills/`,
`toolchains/`) are **bake-rw / worker-ro** — workers never mutate capability
state. Browser profile snapshots (`browser-profiles/`) are the exception:
workers snapshot them at turn end and restore them at launch, so the worker role
gets **read-write** on that prefix only. Both grants are encoded in the storage
module (`bake_rw` / `worker_ro` / `worker_browser_rw` policies) and attached to
the worker role in the env roots; no out-of-band IAM is required.

Treat `browser-profiles/` objects as credential-grade secrets. A snapshot's
full-minus-cache bundle carries Chrome's `Login Data` (saved-passwords DB) and
the `Local State` `os_crypt` key material; on headless Linux that key is
typically derivable, so the bundle is effectively a plaintext credential store.
There is no application-layer encryption, so the bucket posture is the only
protection: keep SSE-KMS, the prefix-scoped worker-rw IAM above, and the
public-access block enabled.

---

## Part A — Local Fleet Rehearsal (≤ 15 min)

Exercises the role-differentiated fleet topology on one machine: Postgres + MinIO

- one `control` process + N `live-worker` + N `job-worker`, all from the same
  built runtime image (differentiated by `GANTRY_PROCESS_ROLE`), health-checked on
  `/readyz`. The root `docker-compose.yml` (Postgres-only dev) is untouched.

From the repo root:

```bash
# 1. Build the image and bring up Postgres + all roles.
docker compose -f ops/docker/docker-compose.fleet.yml up --build

# 2. Scale the worker roles independently (the rehearsal command). Live
#    execution is distributed, so each live-worker adds chat capacity; job
#    workers add job/bake throughput:
docker compose -f ops/docker/docker-compose.fleet.yml up --build \
  --scale live-worker=3 --scale job-worker=2
```

Only the `control` service publishes a host port (`127.0.0.1:8080` for admin/API
verification). Worker replicas take no host port — under `--scale` they would
collide — and are reached on the internal network or via
`docker compose -f ops/docker/docker-compose.fleet.yml exec live-worker <cmd>`.

The `settings-seed` one-shot service runs first: it writes a fleet-marked
`settings.yaml` (`runtime.deployment_mode: fleet`) into the shared
`gantry-fleet-home` volume, **migrates the schema**, and appends settings
**revision 1** with `ops/docker/fleet-settings-seed.mjs` through the normal
container entrypoint. Every role `depend_on`s it completing, so they boot in
fleet mode with desired state already seeded and `/readyz` can go green (a
fleet worker with no revision stays red and logs the seed command). The
`settings-seed` service runs the required first migration/import
(`GANTRY_SKIP_MIGRATIONS=0`); `control` also runs the idempotent entrypoint
migration pass, and workers skip the explicit pass. The entrypoint advisory lock
makes concurrent migration safe regardless.

Expected sequence in the logs:

```
gantry-fleet-postgres      | ... database system is ready to accept connections
gantry-fleet-settings-seed | ... fleet settings revision 1 seeded
gantry-fleet-control-1     | <ts> [entrypoint] running migrations (GANTRY_DATABASE_URL)
gantry-fleet-control-1     | <ts> [entrypoint] migrations complete
gantry-fleet-control-1     | <ts> [entrypoint] starting runtime: node dist/index.js
gantry-fleet-live-worker-1 | ... Loaded fleet settings from revision
gantry-fleet-job-worker-1  | ... Loaded fleet settings from revision
```

To push a new desired state after boot, re-run `gantry settings import --fleet`
(or `PUT /v1/settings/desired-state` against control); all roles converge via
NOTIFY + poll.

Verify readiness against the published control port:

```bash
# Liveness — process is up:
curl -fsS http://127.0.0.1:8080/healthz && echo OK

# Readiness — DB migrated, settings loaded, not draining (200 when green, 503 while
# starting or draining). On control, /readyz also reports role + api_auth:
curl -fsS http://127.0.0.1:8080/readyz && echo READY
```

Worker replicas serve `/readyz` too (ops-only API); check one over the internal
network, e.g.:

```bash
docker compose -f ops/docker/docker-compose.fleet.yml exec live-worker \
  node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>r.text()).then(console.log)"
```

`docker compose ... ps` should show every `control`, `live-worker`, and
`job-worker` replica as `healthy` (the compose healthcheck polls `/readyz`).

First conversation: configure a channel / send a message through whatever channel
the agent is wired to (same product flow as workstation). Tear down with:

```bash
docker compose -f ops/docker/docker-compose.fleet.yml down -v   # -v drops the rehearsal volume
```

---

## Part B — AWS Fleet / Support Stack (≤ 60 min)

The fleet and support roots share the same modules and the same steps. The
**fleet** root (`envs/fleet`) stands up three role pools — `control` (admin/API),
`live-worker` (distributed live execution), and `job-worker` (scheduler + bakes) —
all from one image differentiated by `GANTRY_PROCESS_ROLE`. The **support** root
(`envs/support`) is the minimal, isolated variant: one `all`-role worker that does
everything, registered to both ALB target groups. Use `envs/support` for the
locked support stack and `envs/fleet` for the full fleet. Commands below show
`fleet`; substitute `support` where noted.

### B.0 Prerequisites

- Terraform `>= 1.6`, AWS CLI v2, Docker (to build/push the image), and an AWS
  account with permissions for VPC, RDS, S3, IAM, Secrets Manager, ELB, EC2/ASG.
- A built runtime image pushed somewhere the workers can pull from. CI
  (`.github/workflows/image.yml`) pushes to GHCR on `main`/tags. For private GHCR
  or cross-registry pulls, mirror the image to ECR or grant the worker role pull
  access; set `image_ref` accordingly (pin by digest in production).
- Decide a region. **VERIFY** the chosen RDS Postgres engine version and the
  Amazon Linux 2023 AMI exist in that region (see Assumptions to verify below).

### B.1 Create the Terraform state backend (once per account)

```bash
export AWS_REGION=us-east-1
export TF_STATE_BUCKET=my-org-gantry-tf-state
export TF_LOCK_TABLE=my-org-gantry-tf-locks

aws s3api create-bucket --bucket "$TF_STATE_BUCKET" --region "$AWS_REGION" \
  $( [ "$AWS_REGION" = us-east-1 ] || echo --create-bucket-configuration LocationConstraint="$AWS_REGION" )
aws s3api put-bucket-versioning --bucket "$TF_STATE_BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$TF_STATE_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'

aws dynamodb create-table --table-name "$TF_LOCK_TABLE" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region "$AWS_REGION"
```

State holds infrastructure descriptions but **no secret values** (secrets are
referenced by ARN). Keep the bucket private.

### B.2 Create secrets (out-of-band; values never enter Terraform state)

Create the secret VALUES before apply. Terraform only references their ARNs.

```bash
# RDS master password.
DB_MASTER_ARN=$(aws secretsmanager create-secret \
  --name gantry/fleet/db-master --secret-string "$(openssl rand -base64 24)" \
  --query ARN --output text)

# RDS Proxy credential secret — JSON {username,password}. Username must match the
# database module's master_username (default gantry_admin) OR a role you create
# post-provision. Use the master for first bring-up.
DB_PROXY_ARN=$(aws secretsmanager create-secret \
  --name gantry/fleet/db-proxy \
  --secret-string '{"username":"gantry_admin","password":"<same-as-master>"}' \
  --query ARN --output text)

# Runtime DATABASE_URL (filled in after apply once the proxy endpoint is known;
# create a placeholder now, update its value in B.5). Target the PROXY host and
# sslmode=require. The runtime role may differ from the migration role.
RUNTIME_DBURL_ARN=$(aws secretsmanager create-secret \
  --name gantry/fleet/runtime-db-url --secret-string "postgres://PLACEHOLDER" \
  --query ARN --output text)

echo "DB_MASTER_ARN=$DB_MASTER_ARN"
echo "DB_PROXY_ARN=$DB_PROXY_ARN"
echo "RUNTIME_DBURL_ARN=$RUNTIME_DBURL_ARN"
```

Optionally create a `MIGRATION_DATABASE_URL` secret (migration role ≠ runtime
role) and channel/provider credential secrets; pass them via
`migration_database_url_secret_arn` and `additional_runtime_secret_refs`.

### B.3 Configure tfvars

```bash
cd ops/terraform/envs/fleet           # or envs/support
cp fleet.tfvars.example fleet.auto.tfvars   # support: cp support.tfvars.example support.auto.tfvars
$EDITOR fleet.auto.tfvars
```

Fill `region`, `image_ref`, `worker_ami_id`, and the three secret ARNs from B.2.
Resolve the current AL2023 AMI:

```bash
aws ssm get-parameter --region "$AWS_REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text
```

### B.4 Init / plan / apply

```bash
terraform init \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="key=gantry/fleet/terraform.tfstate" \
  -backend-config="region=$AWS_REGION" \
  -backend-config="dynamodb_table=$TF_LOCK_TABLE" \
  -backend-config="encrypt=true"

terraform plan -out tf.plan        # support adds: -var-file=support.tfvars (if not using *.auto.tfvars)
terraform apply tf.plan
```

**Expected outputs** (values vary):

```
Apply complete! Resources: NN added, 0 changed, 0 destroyed.

Outputs:

alb_dns_name            = "gantry-fleet-alb-1234567890.us-east-1.elb.amazonaws.com"
artifacts_bucket        = "gantry-fleet-artifacts-ab12cd34"
database_endpoint       = "gantry-fleet-pg.abcdef.us-east-1.rds.amazonaws.com"
database_proxy_endpoint = "gantry-fleet-proxy.proxy-abcdefg.us-east-1.rds.amazonaws.com"
control_asg             = "gantry-fleet-control"
live_worker_asg         = "gantry-fleet-live-worker"
job_worker_asg          = "gantry-fleet-job-worker"
# support has a single ASG instead: worker_asg = "gantry-support-all"
```

### B.5 Point the runtime DB URL secret at the proxy

Now that `database_proxy_endpoint` is known, set the real runtime URL value:

```bash
PROXY=$(terraform output -raw database_proxy_endpoint)
aws secretsmanager put-secret-value --secret-id "$RUNTIME_DBURL_ARN" \
  --secret-string "postgres://gantry_app:<runtime-password>@$PROXY:5432/gantry?sslmode=require"
```

Then refresh every pool so each picks up the value (instance refresh, see
Rollback). On fleet, roll all three role ASGs; on support, roll the single one:

```bash
# Fleet: roll all three pools.
for asg in control_asg live_worker_asg job_worker_asg; do
  aws autoscaling start-instance-refresh \
    --auto-scaling-group-name "$(terraform output -raw $asg)"
done

# Support: a single pool.
#   aws autoscaling start-instance-refresh \
#     --auto-scaling-group-name "$(terraform output -raw worker_asg)"
```

> Note: the runtime DB role (`gantry_app`) is created by the database bootstrap.
> On RDS, run the role/grant bootstrap once from a bastion (the same SQL as
> `ops/postgres/init/001-gantry-bootstrap.sh`, adapted for RDS — the master user
> is `gantry_admin`, not `postgres`). The migration entrypoint installs the
> `vector`/`pgcrypto` extensions it needs at migrate time on a supported engine.

### B.6 Seed settings (locked support agents)

The fleet **desired-state control API landed in Phase 3** (ADR-3). Seeding is
either the `gantry settings import --fleet` CLI (appends a settings revision) or
the `PUT /v1/settings/desired-state` control endpoint. Run the CLI **once**
against the fleet/support DB from an operator machine or bastion with network
access to the RDS Proxy:

```bash
# From a bastion in the VPC (or via SSM port-forward), with GANTRY_DATABASE_URL
# pointed at the proxy and a settings.yaml that declares runtime.deployment_mode:
# fleet and the locked support agent (agents.<id>.access.preset: locked):
export GANTRY_DATABASE_URL="postgres://gantry_admin:...@$PROXY:5432/gantry?sslmode=require"
gantry settings import --file settings.yaml --fleet   # validates + appends a revision
# Optionally guard against a concurrent writer:
#   gantry settings import --file settings.yaml --fleet --expected-revision <n>
```

Workers converge on the new revision via `pg_notify` + a poll fallback; a worker
older than a revision's `min_reader_version` holds its last-applied revision and
alerts (the upgrade/skew matrix in deployment-profiles.md enumerates the cases).

For the **support** stack this is where the locked agent (and its pre-provisioned
skills/MCP/capabilities) is established. The locked posture itself is enforced
in the runtime (parent-side); Terraform only sizes and isolates the stack.

### B.7 Health verification

```bash
ALB=$(terraform output -raw alb_dns_name)

# Health/metrics endpoints are NOT exposed on the public ALB listener (it routes
# /v1/* to control and /webhooks/* to the live pool). Verify health from inside
# the VPC (bastion / SSM) against any pool member's control port. /readyz on
# control reports role + api_auth; on live/job workers it reports role +
# worker_registered (+ live_capacity or scheduler):
curl -fsS http://<member-private-ip>:8080/healthz && echo OK
curl -fsS http://<member-private-ip>:8080/readyz  && echo READY

# The ALB's own view of readiness: both target groups should show healthy
# targets. (Fleet has two: -control and -live. On support the single all-role
# worker is healthy in both.)
for tg in gantry-fleet-control gantry-fleet-live; do
  echo "$tg:"
  aws elbv2 describe-target-health \
    --target-group-arn "$(aws elbv2 describe-target-groups \
       --names "$tg" --query 'TargetGroups[0].TargetGroupArn' --output text)" \
    --query 'TargetHealthDescriptions[].TargetHealth.State'
done
# Expected: ["healthy"] once migrations are applied and settings loaded. The
# job-worker pool takes no ALB traffic, so it has no target group — check it via
# its /readyz directly.
```

First locked support-agent turn: send a message through the configured channel
(its webhook resolves to `https://$ALB/webhooks/...`). The locked agent responds
using only pre-provisioned capabilities; any `request_*`/`admin_*`/`settings_*`
attempt is denied parent-side and audited.

### B.8 Rollback (instance refresh to the previous image tag)

Migrations are additive-only, so an older image runs against a newer schema. To
roll back the running code, point `image_ref` at the previous tag/digest and
re-apply (the launch template changes → instance refresh rolls the fleet):

```bash
# In tfvars: image_ref = "ghcr.io/<org>/gantry@sha256:<previous-digest>"
terraform apply
# Or trigger a refresh directly without a template change. Fleet rolls all three
# pools; support rolls its single pool:
for asg in control_asg live_worker_asg job_worker_asg; do
  aws autoscaling start-instance-refresh \
    --auto-scaling-group-name "$(terraform output -raw $asg)"
done
# Support: aws autoscaling start-instance-refresh \
#   --auto-scaling-group-name "$(terraform output -raw worker_asg)"
```

Drain is graceful: the terminate lifecycle hook holds each instance in
`Terminating:Wait` while the on-instance watcher `docker stop`s the container
(SIGTERM → `/readyz` 503 → finish/hand off live turns → bounded deadline), then
completes the lifecycle action. A draining live worker's owned turns finish or
hand off while the rest of the live pool keeps serving; if it held the recovery
coordinator lease, another live worker is re-elected (RTO ≈ lease TTL).

### B.9 Teardown

```bash
terraform destroy        # support: -var-file=support.tfvars if not using *.auto.tfvars
```

`deletion_protection = true` on the database blocks destroy until you set it
false and re-apply (or take a final snapshot). S3 artifacts and RDS revisions are
destroyed with the stack unless `force_destroy`/snapshots are configured. Delete
the secrets created in B.2 separately if no longer needed.

---

## Sizing and scaling

> Deciding **whether** to scale up (vertical) or out (horizontal)? Start with
> the symptom-driven decision table in the
> [Scaling Decision Guide](../architecture/deployment-profiles.md#scaling-decision-guide-vertical-vs-horizontal);
> this section covers the AWS-side mechanics.

**Memory model (process-per-turn).** The parent runtime process idles around
~200 MB. Each _active_ turn spawns a runner subprocess costing roughly
150–400 MB depending on tools and context size. Sessions are Postgres rows —
an idle session costs nothing on the worker, only active turns consume memory.
Rough capacity guidance per worker: **4 GB ≈ 8–12 concurrent turns, 8 GB ≈
20–30**. CPU is rarely the first limit; memory is — size instances by expected
concurrent turns, not load average.

**Three role pools.** The fleet runs three ASGs from one image, differentiated by
`GANTRY_PROCESS_ROLE`:

- **`live-worker`** (`live_worker_min_size`/`live_worker_max_size`, CPU target
  tracking via `live_worker_autoscaling_enabled = true`). Live execution is
  **distributed** — every live worker polls and admits turns, bounding itself with
  per-worker `runtime.queue.max_message_runs`. Cluster live capacity ≈
  `max_message_runs` × instance count, so **more live workers = more chat
  capacity**. This is the pool to scale out for concurrent conversations. Keep
  `live_worker_min_size >= 2` (enforced): a warm pool for capacity and for
  recovery-coordinator failover.
- **`job-worker`** (`job_worker_min_size`/`job_worker_max_size`, CPU target
  tracking). Scheduler + bakes; jobs are claimable by any job worker, so this
  scales out on job/bake load. Takes no ALB traffic.
- **`control`** (`control_min_size`/`control_max_size`; autoscaling **off** by
  default). Admin/settings API only, no execution — usually one box. Raise its
  size + `control_autoscaling_enabled` only if the API surface itself is the
  bottleneck (rare).

If multiple Gantry runtime processes are ever co-located on one EC2 instance,
give them the same `GANTRY_HOST_ID`; the default ASG profile is one runtime role
per instance, so the instance hostname is already the host identity.

The scaling policy owns desired capacity once enabled; steer a running pool via
its `*_min_size`/`*_max_size`, not `*_desired_capacity`.

**Scale-in and live turns.** Every termination goes through the terminate
lifecycle hook (B.8): SIGTERM, `/readyz` 503, finish or hand off owned turns,
bounded deadline. Scaling in a live worker only moves **its** owned turns — the
rest of the live pool keeps polling and admitting, so there is no global chat
pause. If the terminated instance held the recovery-coordinator lease, a standby
live worker is re-elected within ≈ a lease TTL (~30s) and resumes any turn the
old coordinator was recovering, at a higher fencing version — loss-free.

**Live-chat throughput scales horizontally.** Unlike the original
single-live-host fleet, adding `live-worker` instances adds chat capacity
directly. Scale out with `live_worker_max_size`; scale per-box with a bigger
`live_worker_instance_type` plus a higher `runtime.queue.max_message_runs`. The
horizontal-scale signal is `gantry_live_oldest_waiting_seconds` /
`gantry_live_slots_used_cluster` (see deployment-profiles.md, Health/Readiness,
and Metrics), and the user-visible backpressure after the wait threshold is the
"Still starting this request." status.

**Always-on floor.** The live pool minimum is two instances
(`live_worker_min_size >= 2`); control and job pools default to one each.
Scale-to-zero is not supported on any pool: a cold worker means webhook latency or
drops on the first customer message of the day, lapsed lease heartbeats and
recovery churn, and a multi-minute boot (Docker install, image pull, migration,
settings load) before `/readyz` goes green.

**Upgrade path: queue-depth scaling.** CPU is a proxy; the truthful scaling
signal is queue depth (pending runs per eligible worker), which the runtime
already exposes as Prometheus gauges on the internal `/metrics` endpoint. The
upgrade is: run the CloudWatch agent on workers with a Prometheus scrape of the
`gantry_*` gauges, publish them as CloudWatch custom metrics, and replace the
predefined CPU specification in the worker_pool scaling policy with a
customized-metric target tracking configuration on queue depth per instance.
Not built in v1 — revisit when CPU tracking visibly lags real load.

---

## Assumptions an operator must verify

- **RDS engine version**: the modules default to `db_engine_version = "16.8"`
  (16.x line matches the local `pgvector/pgvector:pg16` image and supports
  pgvector 0.8.x). Confirm the exact available minor in your region:
  `aws rds describe-db-engine-versions --engine postgres --query 'DBEngineVersions[].EngineVersion'`.
- **AMI**: `worker_ami_id` must be a current Amazon Linux 2023 AMI in your region
  whose architecture matches the instance types. Resolve via the SSM public
  parameter shown in B.3.
- **Region**: every default (engine version, AMI, instance types) must exist in
  the region you pick.
- **Image pull**: workers must be able to pull `image_ref`. GHCR private images
  require either an ECR mirror or pull credentials on the instance.
- **DB role bootstrap**: the runtime DB role/grants are created once on RDS (B.5
  note); the local compose bootstrap script is not run on RDS automatically.
- **TLS / cert**: production should set `certificate_arn` so the ALB serves HTTPS;
  without it the module creates an HTTP-only listener (rehearsal posture).
