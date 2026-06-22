variable "region" {
  description = "AWS region for the ECS stack. VERIFY the chosen RDS engine version and ECS-optimized AMI exist in this region."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for all resource names."
  type        = string
  default     = "gantry-ecs"
}

variable "deployment_type" {
  description = "ECS role layout to deploy: api-only, chat-only, jobs-only, or all. all means control + live-worker + job-worker."
  type        = string
  default     = "all"

  validation {
    condition     = contains(["api-only", "chat-only", "jobs-only", "all"], var.deployment_type)
    error_message = "deployment_type must be one of: api-only, chat-only, jobs-only, all."
  }
}

variable "image_ref" {
  description = "Container image the ECS tasks run. Pin by digest in production."
  type        = string
}

variable "control_port" {
  description = "Container control port exposed by Gantry."
  type        = number
  default     = 8080
}

# --- Secret REFERENCES (ARNs). Create the secret values out-of-band before
#     apply. ECS injects these as task-definition secrets, so no secret values
#     enter Terraform state.

variable "runtime_database_url_secret_arn" {
  description = "Secrets Manager ARN of the runtime DATABASE_URL secret targeting the RDS Proxy endpoint. Injected as GANTRY_DATABASE_URL."
  type        = string
}

variable "db_proxy_secret_arn" {
  description = "Secrets Manager ARN of the RDS Proxy runtime-role credential secret (JSON {username,password}). Referenced, never read into state."
  type        = string
}

variable "secret_encryption_key_secret_arn" {
  description = "Secrets Manager ARN of the SECRET_ENCRYPTION_KEY secret."
  type        = string
}

variable "gantry_ipc_auth_secret_arn" {
  description = "Secrets Manager ARN of the GANTRY_IPC_AUTH_SECRET secret."
  type        = string
}

variable "gantry_control_api_keys_json_secret_arn" {
  description = "Secrets Manager ARN of the GANTRY_CONTROL_API_KEYS_JSON secret."
  type        = string
}

variable "migration_database_url_secret_arn" {
  description = "Optional Secrets Manager ARN of the MIGRATION_DATABASE_URL secret. Empty string disables it."
  type        = string
  default     = ""
}

variable "additional_runtime_secret_refs" {
  description = "Extra runtime secrets to inject into ECS tasks as env vars: list of { env_name, secret_arn }."
  type = list(object({
    env_name   = string
    secret_arn = string
  }))
  default = []
}

variable "secret_kms_key_arns" {
  description = "KMS key ARNs encrypting referenced secrets, if customer-managed."
  type        = list(string)
  default     = []
}

# --- Database sizing. ---

variable "db_engine_version" {
  description = "RDS PostgreSQL engine version."
  type        = string
  default     = "16.8"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_multi_az" {
  description = "Enable RDS Multi-AZ."
  type        = bool
  default     = true
}

variable "db_deletion_protection" {
  description = "Protect the database from terraform destroy."
  type        = bool
  default     = true
}

# --- ECS capacity. ---

variable "ecs_capacity_ami_id" {
  description = "ECS-optimized AMI ID for container instances. Empty resolves the latest Amazon Linux 2023 ECS-optimized AMI from SSM."
  type        = string
  default     = ""
}

variable "ecs_capacity_instance_type" {
  description = "EC2 instance type for ECS container instances."
  type        = string
  default     = "c7i.2xlarge"
}

variable "ecs_capacity_min_size" {
  description = "Minimum ECS container instance ASG size."
  type        = number
  default     = 1
}

variable "ecs_capacity_max_size" {
  description = "Maximum ECS container instance ASG size."
  type        = number
  default     = 6
}

variable "ecs_capacity_desired_capacity" {
  description = "Initial ECS container instance count. ECS managed scaling owns this after apply."
  type        = number
  default     = 2
}

variable "ecs_capacity_root_volume_gb" {
  description = "Root EBS volume size in GiB for image layers, workspaces, sandbox temp dirs, and artifact cache."
  type        = number
  default     = 80
}

variable "ecs_managed_scaling_target_capacity" {
  description = "Target utilization percentage for ECS managed scaling on the EC2 capacity provider."
  type        = number
  default     = 80
}

variable "service_configs" {
  description = "Per-role ECS task and autoscaling settings keyed by control, live-worker, and job-worker."
  type = map(object({
    desired_count       = number
    min_capacity        = number
    max_capacity        = number
    autoscaling_enabled = bool
    cpu_target_value    = number
    task_cpu            = number
    task_memory         = number
  }))
  default = {
    control = {
      desired_count       = 1
      min_capacity        = 1
      max_capacity        = 2
      autoscaling_enabled = true
      cpu_target_value    = 60
      task_cpu            = 512
      task_memory         = 1024
    }
    live-worker = {
      desired_count       = 2
      min_capacity        = 2
      max_capacity        = 6
      autoscaling_enabled = true
      cpu_target_value    = 60
      task_cpu            = 4096
      task_memory         = 8192
    }
    job-worker = {
      desired_count       = 1
      min_capacity        = 1
      max_capacity        = 4
      autoscaling_enabled = true
      cpu_target_value    = 60
      task_cpu            = 4096
      task_memory         = 8192
    }
  }
}

# --- Ingress. Required only for deployment types containing control. ---

variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener. Required for api-only, chat-only, and all."
  type        = string
  default     = ""
}

variable "force_new_deployment" {
  description = "Force ECS services to roll tasks on apply. Useful after referenced Secrets Manager values rotate."
  type        = bool
  default     = false
}

variable "enable_execute_command" {
  description = "Enable ECS Exec for operational break-glass access when the cluster has the required SSM/KMS plumbing."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags merged into the provider default_tags."
  type        = map(string)
  default     = {}
}
