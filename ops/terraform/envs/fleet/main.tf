# Fleet root module: wires network -> storage/secrets -> control -> worker pools
# -> database. Secrets are passed as ARNs only; no secret values enter state.
#
# Topology (role-differentiated fleet): three worker pools behind one ALB, one
# image differentiated by GANTRY_PROCESS_ROLE, against RDS (pgvector) via RDS
# Proxy, with capability artifacts in S3:
#   - control     control plane: full admin/settings API; takes /v1/* from the
#                 ALB; runs no live/job execution, no bakes; does not register as
#                 a worker. Default min 1.
#   - live_worker live admission/execution + provider inbound; takes /webhooks/*
#                 from the ALB; ops-only API. Live execution is horizontally
#                 distributed, so adding instances adds chat capacity linearly.
#                 Autoscaled, min 2 (a warm pool for capacity + recovery
#                 coordinator failover).
#   - job_worker  scheduler + bakes + job-notification delivery; channels
#                 outbound-only; ops-only API; takes no ALB traffic. Jobs are
#                 claimable by any job-worker (run-lease + fencing), so this
#                 scales horizontally. Autoscaled.

locals {
  name_prefix = var.name_prefix

  # Runtime secrets injected into every worker as env vars. The DB URL is
  # required; the migration URL and any extras are appended when set.
  base_runtime_refs = concat(
    [
      { env_name = "GANTRY_DATABASE_URL", secret_arn = var.runtime_database_url_secret_arn },
      { env_name = "SECRET_ENCRYPTION_KEY", secret_arn = var.secret_encryption_key_secret_arn },
      { env_name = "GANTRY_IPC_AUTH_SECRET", secret_arn = var.gantry_ipc_auth_secret_arn },
      { env_name = "GANTRY_CONTROL_API_KEYS_JSON", secret_arn = var.gantry_control_api_keys_json_secret_arn },
    ],
    var.migration_database_url_secret_arn != "" ?
    [{ env_name = "MIGRATION_DATABASE_URL", secret_arn = var.migration_database_url_secret_arn }] : [],
    var.additional_runtime_secret_refs,
  )

  # Distinct secret ARNs the worker role must be allowed to read.
  worker_secret_arns = distinct([for r in local.base_runtime_refs : r.secret_arn])
}

module "network" {
  source      = "../../modules/network"
  name_prefix = local.name_prefix
  tags        = var.tags
}

module "storage" {
  source      = "../../modules/storage"
  name_prefix = local.name_prefix
  tags        = var.tags
}

module "secrets" {
  source              = "../../modules/secrets"
  name_prefix         = local.name_prefix
  runtime_secret_arns = local.worker_secret_arns
  kms_key_arns        = var.secret_kms_key_arns
  tags                = var.tags
}

module "control" {
  source            = "../../modules/control"
  name_prefix       = local.name_prefix
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  certificate_arn   = var.certificate_arn
  tags              = var.tags
}

locals {
  # Policies attached to every worker instance role: read-only artifacts +
  # read on the referenced runtime secrets (when any).
  worker_instance_policy_arns = compact([
    module.storage.worker_ro_policy_arn,
    module.storage.worker_browser_rw_policy_arn,
    module.secrets.runtime_secret_read_policy_arn,
  ])
}

# Control plane pool. Takes /v1/* from the ALB (control target group). Runs no
# live/job execution, no bakes; does not register as a worker. Usually one
# instance; raise control_max_size + control_autoscaling_enabled if the admin/
# API surface itself needs more headroom (rare — execution lives on the worker
# roles). The control role still serves /readyz for the ALB health check.
module "control_worker" {
  source                  = "../../modules/worker_pool"
  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  subnet_ids              = module.network.private_subnet_ids
  image_ref               = var.image_ref
  ami_id                  = var.worker_ami_id
  instance_type           = var.control_instance_type
  process_role            = "control"
  min_size                = var.control_min_size
  max_size                = var.control_max_size
  desired_capacity        = var.control_desired_capacity
  autoscaling_enabled     = var.control_autoscaling_enabled
  cpu_target_value        = var.control_cpu_target
  drain_deadline_seconds  = var.drain_deadline_seconds
  target_group_arns       = [module.control.control_target_group_arn]
  alb_security_group_id   = module.control.alb_security_group_id
  instance_policy_arns    = local.worker_instance_policy_arns
  runtime_secret_env_refs = local.base_runtime_refs
  artifact_bucket_name    = module.storage.bucket_name
  tags                    = var.tags
}

# Live-worker pool. Takes /webhooks/* from the ALB (live target group) and runs
# distributed live admission/execution + provider inbound. Live capacity scales
# with the instance count (each worker bounds itself with max_message_runs), so
# this is the pool to scale out for more concurrent chat. min_size >= 2 keeps a
# warm pool for capacity headroom and recovery-coordinator failover (the
# coordinator lease re-elects onto any live worker on drain; RTO ~= lease TTL).
module "live_worker" {
  source                  = "../../modules/worker_pool"
  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  subnet_ids              = module.network.private_subnet_ids
  image_ref               = var.image_ref
  ami_id                  = var.worker_ami_id
  instance_type           = var.live_worker_instance_type
  process_role            = "live-worker"
  min_size                = var.live_worker_min_size
  max_size                = var.live_worker_max_size
  desired_capacity        = var.live_worker_desired_capacity
  autoscaling_enabled     = var.live_worker_autoscaling_enabled
  cpu_target_value        = var.live_worker_cpu_target
  drain_deadline_seconds  = var.drain_deadline_seconds
  target_group_arns       = [module.control.live_target_group_arn]
  alb_security_group_id   = module.control.alb_security_group_id
  instance_policy_arns    = local.worker_instance_policy_arns
  runtime_secret_env_refs = local.base_runtime_refs
  artifact_bucket_name    = module.storage.bucket_name
  tags                    = var.tags
}

# Job-worker pool. Scheduler + bakes + job-notification delivery; channels
# outbound-only. Takes NO ALB traffic (no target group; the ALB SG is empty so
# the pool's control port is reachable only inside the VPC for ops checks). Jobs
# are claimable by any job-worker, so this scales horizontally on job/bake load.
module "job_worker" {
  source                  = "../../modules/worker_pool"
  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  subnet_ids              = module.network.private_subnet_ids
  image_ref               = var.image_ref
  ami_id                  = var.worker_ami_id
  instance_type           = var.job_worker_instance_type
  process_role            = "job-worker"
  min_size                = var.job_worker_min_size
  max_size                = var.job_worker_max_size
  desired_capacity        = var.job_worker_desired_capacity
  autoscaling_enabled     = var.job_worker_autoscaling_enabled
  cpu_target_value        = var.job_worker_cpu_target
  drain_deadline_seconds  = var.drain_deadline_seconds
  target_group_arns       = []
  alb_security_group_id   = ""
  instance_policy_arns = concat(
    local.worker_instance_policy_arns,
    [module.storage.bake_rw_policy_arn],
  )
  runtime_secret_env_refs = local.base_runtime_refs
  artifact_bucket_name    = module.storage.bucket_name
  tags                    = var.tags
}

module "database" {
  source                     = "../../modules/database"
  name_prefix                = local.name_prefix
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  engine_version             = var.db_engine_version
  instance_class             = var.db_instance_class
  multi_az                   = var.db_multi_az
  deletion_protection        = var.db_deletion_protection
  proxy_secret_arn           = var.db_proxy_secret_arn
  kms_key_arns               = var.secret_kms_key_arns
  ingress_security_group_ids = [
    module.control_worker.security_group_id,
    module.live_worker.security_group_id,
    module.job_worker.security_group_id,
  ]
  tags = var.tags
}
