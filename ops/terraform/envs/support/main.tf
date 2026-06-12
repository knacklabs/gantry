# Support root module: minimal isolated stack. ONE worker in the `all` process
# role — it runs everything (control API + live + jobs + bakes) in one process,
# because support load is small and a single box does not warrant the role split.
# That one worker registers to BOTH ALB target groups (control + live), so /v1/*
# and /webhooks/* both reach it. Multi-AZ off, single NAT, small DB. Locked-agent
# settings are seeded post-apply with `gantry settings import` (see runbook); the
# locked posture itself is enforced in the runtime, not here.

locals {
  name_prefix = var.name_prefix

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

  worker_secret_arns = distinct([for r in local.base_runtime_refs : r.secret_arn])
}

module "network" {
  source             = "../../modules/network"
  name_prefix        = local.name_prefix
  single_nat_gateway = true # minimal: one shared NAT
  tags               = var.tags
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
  worker_instance_policy_arns = compact([
    module.storage.worker_ro_policy_arn,
    module.storage.worker_browser_rw_policy_arn,
    module.secrets.runtime_secret_read_policy_arn,
  ])
}

# Single support worker: 1 instance in the `all` role, doing everything. Fixed
# size, no scaling policy — minimal stack scales vertically only
# (worker_instance_type); support load does not warrant a horizontal pool or the
# role split. Registers to both ALB target groups so /v1/* and /webhooks/* both
# land on the one box.
module "worker" {
  source                 = "../../modules/worker_pool"
  name_prefix            = local.name_prefix
  vpc_id                 = module.network.vpc_id
  subnet_ids             = module.network.private_subnet_ids
  image_ref              = var.image_ref
  ami_id                 = var.worker_ami_id
  instance_type          = var.worker_instance_type
  process_role           = "all"
  min_size               = 1
  max_size               = 1
  desired_capacity       = 1
  autoscaling_enabled    = false
  drain_deadline_seconds = var.drain_deadline_seconds
  target_group_arns = [
    module.control.control_target_group_arn,
    module.control.live_target_group_arn,
  ]
  alb_security_group_id   = module.control.alb_security_group_id
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
  multi_az                   = false # minimal support stack
  deletion_protection        = true
  proxy_secret_arn           = var.db_proxy_secret_arn
  kms_key_arns               = var.secret_kms_key_arns
  ingress_security_group_ids = [module.worker.security_group_id]
  tags                       = var.tags
}
