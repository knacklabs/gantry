# Support root module: minimal isolated stack. One combined worker (live + job
# in a single instance, since support load is small and v1 keeps a singleton
# live host anyway). Multi-AZ off, single NAT, small DB. Locked-agent settings
# are seeded post-apply with `gantry settings import` (see runbook); the locked
# posture itself is enforced in the runtime, not here.

locals {
  name_prefix = var.name_prefix

  base_runtime_refs = concat(
    [{ env_name = "GANTRY_DATABASE_URL", secret_arn = var.runtime_database_url_secret_arn }],
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
  worker_instance_policy_arns = compact([
    module.storage.worker_ro_policy_arn,
    module.secrets.runtime_secret_read_policy_arn,
  ])
}

# Single support worker: 1 instance, takes ALB traffic, holds the live lease.
module "worker" {
  source                  = "../../modules/worker_pool"
  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  subnet_ids              = module.network.private_subnet_ids
  image_ref               = var.image_ref
  ami_id                  = var.worker_ami_id
  instance_type           = var.worker_instance_type
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

module "database" {
  source                     = "../../modules/database"
  name_prefix                = local.name_prefix
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  engine_version             = var.db_engine_version
  instance_class             = var.db_instance_class
  multi_az                   = false # minimal support stack
  deletion_protection        = true
  master_password_secret_arn = var.db_master_password_secret_arn
  proxy_role_arn             = module.secrets.proxy_role_arn
  proxy_secret_arn           = var.db_proxy_secret_arn
  ingress_security_group_ids = [module.worker.security_group_id]
  tags                       = var.tags
}
