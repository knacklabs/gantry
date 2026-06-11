# Gantry on AWS — Terraform Runbook

Copy-paste runbook for standing up a Gantry **fleet** or **locked support** stack
on AWS with Terraform, plus a short local-rehearsal section.

Targets (measured gates from the deployment-modes plan):

- **Local fleet rehearsal → first conversation: ≤ 15 min.**
- **Clean AWS account → first locked support-agent turn: ≤ 60 min.**

Background: [deployment-profiles.md](../architecture/deployment-profiles.md) and the
ADRs under [docs/decisions/](../decisions/) (delivery vehicle, deployment modes,
capability artifacts, locked preset).

Module reference: `ops/terraform/modules/{network,database,storage,secrets,worker_pool,control}`,
roots `ops/terraform/envs/{fleet,support}`. Image: `ops/docker/Dockerfile` +
`ops/docker/entrypoint.sh`.

---

## Part A — Local Fleet Rehearsal (≤ 15 min)

Exercises the fleet topology on one machine: Postgres + 1 live worker + N job
workers from the built runtime image, migrating via the entrypoint, health-checked
on `/readyz`. The root `docker-compose.yml` (Postgres-only dev) is untouched.

From the repo root:

```bash
# 1. Build the image and bring up Postgres + workers.
docker compose -f ops/docker/docker-compose.fleet.yml up --build

#    Scale job workers (advisory-locked migrations make concurrent boot safe):
#    docker compose -f ops/docker/docker-compose.fleet.yml up --build --scale job-worker=3
```

The `settings-seed` one-shot service runs first: it writes a fleet-marked
`settings.yaml` (`runtime.deployment_mode: fleet`) into the shared
`gantry-fleet-home` volume and appends settings **revision 1** via
`gantry settings import --fleet`. Workers `depend_on` it completing, so they
boot in fleet mode with desired state already seeded and `/readyz` can go green
(a fleet worker with no revision stays red and logs the seed command).

Expected sequence in the logs:

```
gantry-fleet-postgres    | ... database system is ready to accept connections
gantry-fleet-settings-seed | ... Appended fleet settings revision 1.
gantry-fleet-live-worker | <ts> [entrypoint] running migrations (GANTRY_DATABASE_URL)
gantry-fleet-live-worker | <ts> [entrypoint] migrations complete
gantry-fleet-live-worker | <ts> [entrypoint] starting runtime: node dist/index.js
gantry-fleet-live-worker | ... Loaded fleet settings from revision
```

To push a new desired state after boot, re-run `gantry settings import --fleet`
(or `PUT /v1/settings/desired-state`); workers converge via NOTIFY + poll.

Verify readiness (control port published on 127.0.0.1:8080):

```bash
# Liveness — process is up:
curl -fsS http://127.0.0.1:8080/healthz && echo OK

# Readiness — DB migrated, settings loaded, not draining (200 when green, 503 while
# starting or draining):
curl -fsS http://127.0.0.1:8080/readyz && echo READY
```

`docker compose ... ps` should show `live-worker` as `healthy` (the compose
healthcheck polls `/readyz`).

First conversation: configure a channel / send a message through whatever channel
the agent is wired to (same product flow as workstation). Tear down with:

```bash
docker compose -f ops/docker/docker-compose.fleet.yml down -v   # -v drops the rehearsal volume
```

---

## Part B — AWS Fleet / Support Stack (≤ 60 min)

The fleet and support roots share the same modules and the same steps; support is
the minimal, isolated variant (`-var-file=support.tfvars`, one worker). Use the
`envs/support` directory for the locked support stack and `envs/fleet` for the
full fleet. Commands below show `fleet`; substitute `support` where noted.

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
job_worker_asg          = "gantry-fleet-job"      # (fleet only)
live_worker_asg         = "gantry-fleet-live"     # support: worker_asg = "gantry-support-live"
```

### B.5 Point the runtime DB URL secret at the proxy

Now that `database_proxy_endpoint` is known, set the real runtime URL value:

```bash
PROXY=$(terraform output -raw database_proxy_endpoint)
aws secretsmanager put-secret-value --secret-id "$RUNTIME_DBURL_ARN" \
  --secret-string "postgres://gantry_app:<runtime-password>@$PROXY:5432/gantry?sslmode=require"
```

Then refresh workers so they pick up the value (instance refresh, see Rollback):

```bash
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name "$(terraform output -raw live_worker_asg)"
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

# Health/metrics endpoints are NOT exposed on the public ALB listener (only
# webhook/API paths are). Verify health from inside the VPC (bastion / SSM)
# against a worker's control port:
curl -fsS http://<worker-private-ip>:8080/healthz && echo OK
curl -fsS http://<worker-private-ip>:8080/readyz  && echo READY

# The ALB's own view of readiness: target group should show healthy targets.
aws elbv2 describe-target-health \
  --target-group-arn "$(aws elbv2 describe-target-groups \
     --names gantry-fleet-workers --query 'TargetGroups[0].TargetGroupArn' --output text)" \
  --query 'TargetHealthDescriptions[].TargetHealth.State'
# Expected: ["healthy"] once migrations are applied and settings loaded.
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
# Or trigger a refresh directly without a template change:
aws autoscaling start-instance-refresh --auto-scaling-group-name "$(terraform output -raw live_worker_asg)"
aws autoscaling start-instance-refresh --auto-scaling-group-name "$(terraform output -raw job_worker_asg)"   # fleet only
```

Drain is graceful: the terminate lifecycle hook holds each instance in
`Terminating:Wait` while the on-instance watcher `docker stop`s the container
(SIGTERM → `/readyz` 503 → finish/hand off live turns → bounded deadline), then
completes the lifecycle action.

### B.9 Teardown

```bash
terraform destroy        # support: -var-file=support.tfvars if not using *.auto.tfvars
```

`deletion_protection = true` on the database blocks destroy until you set it
false and re-apply (or take a final snapshot). S3 artifacts and RDS revisions are
destroyed with the stack unless `force_destroy`/snapshots are configured. Delete
the secrets created in B.2 separately if no longer needed.

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
