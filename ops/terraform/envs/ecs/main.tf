# ECS root module: role-differentiated Gantry services on ECS/EC2 capacity
# providers. The deployment_type switch creates only the requested services:
# api-only => control, chat-only => control + live-worker, jobs-only =>
# job-worker, all => control + live-worker + job-worker.

locals {
  name_prefix = var.name_prefix
  cluster_name = "${local.name_prefix}-ecs"
  has_control = contains(["api-only", "chat-only", "all"], var.deployment_type)
  capacity_provider_name = "${local.name_prefix}-workers"

  runtime_secret_refs = concat(
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

module "control" {
  count = local.has_control ? 1 : 0

  source               = "../../modules/control"
  name_prefix          = local.name_prefix
  vpc_id               = module.network.vpc_id
  public_subnet_ids    = module.network.public_subnet_ids
  certificate_arn      = var.certificate_arn
  target_type          = "ip"
  enable_webhook_paths = contains(["chat-only", "all"], var.deployment_type)
  tags                 = var.tags
}

module "ecs_capacity" {
  source = "../../modules/ecs_capacity"

  name_prefix      = local.name_prefix
  cluster_name     = local.cluster_name
  vpc_id           = module.network.vpc_id
  subnet_ids       = module.network.private_subnet_ids
  ami_id           = var.ecs_capacity_ami_id
  instance_type    = var.ecs_capacity_instance_type
  min_size         = var.ecs_capacity_min_size
  max_size         = var.ecs_capacity_max_size
  desired_capacity = var.ecs_capacity_desired_capacity
  root_volume_gb   = var.ecs_capacity_root_volume_gb
  tags             = var.tags
}

module "ecs" {
  source = "../../modules/ecs_service_set"

  name_prefix              = local.name_prefix
  deployment_type          = var.deployment_type
  vpc_id                   = module.network.vpc_id
  subnet_ids               = module.network.private_subnet_ids
  alb_security_group_id    = local.has_control ? module.control[0].alb_security_group_id : ""
  control_target_group_arn = local.has_control ? module.control[0].control_target_group_arn : ""
  live_target_group_arn    = contains(["chat-only", "all"], var.deployment_type) ? module.control[0].live_target_group_arn : ""
  image_ref                = var.image_ref
  control_port             = var.control_port
  artifact_bucket_name     = module.storage.bucket_name
  runtime_secret_env_refs  = local.runtime_secret_refs
  secret_kms_key_arns      = var.secret_kms_key_arns
  task_policy_arns = [
    module.storage.worker_ro_policy_arn,
  ]
  task_policy_arns_by_role = {
    live-worker = [module.storage.worker_browser_rw_policy_arn]
    job-worker  = [module.storage.worker_browser_rw_policy_arn]
  }
  ec2_capacity_providers = {
    workers = {
      auto_scaling_group_arn          = module.ecs_capacity.asg_arn
      managed_scaling_status          = "ENABLED"
      managed_scaling_target_capacity = var.ecs_managed_scaling_target_capacity
      managed_termination_protection  = "ENABLED"
    }
  }
  default_capacity_provider_strategy = [
    {
      capacity_provider = local.capacity_provider_name
      weight            = 1
      base              = 0
    }
  ]
  service_configs       = var.service_configs
  force_new_deployment  = var.force_new_deployment
  enable_execute_command = var.enable_execute_command
  tags                  = var.tags
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
  ingress_security_group_ids = [module.ecs.security_group_id]
  tags                       = var.tags
}
