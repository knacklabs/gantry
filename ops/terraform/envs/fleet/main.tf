# Fleet root module: wires network -> storage/secrets -> control -> worker pools
# -> database. Secrets are passed as ARNs only; no secret values enter state.
#
# Topology (fleet v1): 1 live-host worker + N job workers behind one ALB,
# against RDS (pgvector) via RDS Proxy, with capability artifacts in S3.

locals {
  name_prefix = var.name_prefix

  # Runtime secrets injected into every worker as env vars. The DB URL is
  # required; the migration URL and any extras are appended when set.
  base_runtime_refs = concat(
    [{ env_name = "GANTRY_DATABASE_URL", secret_arn = var.runtime_database_url_secret_arn }],
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
  proxy_secret_arn    = var.db_proxy_secret_arn
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
    module.secrets.runtime_secret_read_policy_arn,
  ])
}

# Singleton live-host worker: takes ALB traffic (live channel turns route here),
# holds the live-turn host lease. One instance (min=max=desired=1).
module "live_worker" {
  source                  = "../../modules/worker_pool"
  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  subnet_ids              = module.network.private_subnet_ids
  image_ref               = var.image_ref
  ami_id                  = var.worker_ami_id
  instance_type           = var.live_worker_instance_type
  worker_role             = "live"
  min_size                = 1
  max_size                = 1
  desired_capacity        = 1
  drain_deadline_seconds  = var.drain_deadline_seconds
  target_group_arns       = [module.control.target_group_arn]
  alb_security_group_id   = module.control.alb_security_group_id
  instance_policy_arns    = local.worker_instance_policy_arns
  runtime_secret_env_refs = local.base_runtime_refs
  tags                    = var.tags
}

# Horizontal job workers: scheduler/job execution + bake jobs. Also registered
# to the ALB so webhook/API traffic can spread across them.
module "job_worker" {
  source                  = "../../modules/worker_pool"
  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  subnet_ids              = module.network.private_subnet_ids
  image_ref               = var.image_ref
  ami_id                  = var.worker_ami_id
  instance_type           = var.job_worker_instance_type
  worker_role             = "job"
  min_size                = var.job_worker_min_size
  max_size                = var.job_worker_max_size
  desired_capacity        = var.job_worker_desired_capacity
  drain_deadline_seconds  = var.drain_deadline_seconds
  target_group_arns       = [module.control.target_group_arn]
  alb_security_group_id   = module.control.alb_security_group_id
  instance_policy_arns    = local.worker_instance_policy_arns
  runtime_secret_env_refs = local.base_runtime_refs
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
  master_password_secret_arn = var.db_master_password_secret_arn
  proxy_role_arn             = module.secrets.proxy_role_arn
  proxy_secret_arn           = var.db_proxy_secret_arn
  ingress_security_group_ids = [
    module.live_worker.security_group_id,
    module.job_worker.security_group_id,
  ]
  tags = var.tags
}
