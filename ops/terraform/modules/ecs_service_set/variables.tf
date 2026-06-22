variable "name_prefix" {
  description = "Prefix for ECS resource names and Name tags."
  type        = string
}

variable "deployment_type" {
  description = "Role layout to deploy: api-only, chat-only, jobs-only, or all."
  type        = string
  default     = "all"

  validation {
    condition     = contains(["api-only", "chat-only", "jobs-only", "all"], var.deployment_type)
    error_message = "deployment_type must be one of: api-only, chat-only, jobs-only, all."
  }
}

variable "vpc_id" {
  description = "VPC the ECS services run in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for ECS service awsvpc networking."
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "ALB security group ID allowed to reach the control service. Leave empty for jobs-only deployments."
  type        = string
  default     = ""
}

variable "control_target_group_arn" {
  description = "Public ALB target group ARN for the control service."
  type        = string
  default     = ""
}

variable "live_target_group_arn" {
  description = "Public ALB target group ARN for live-worker webhook ingress."
  type        = string
  default     = ""
}

variable "image_ref" {
  description = "Fully-qualified Gantry container image reference. Pin by digest in production."
  type        = string
}

variable "control_port" {
  description = "Container control port exposed by Gantry."
  type        = number
  default     = 8080
}

variable "artifact_bucket_name" {
  description = "S3 artifact bucket name seeded into fleet settings.yaml."
  type        = string
}

variable "runtime_secret_env_refs" {
  description = "Runtime secrets injected with ECS task-definition secrets: list of { env_name, secret_arn }. No secret values enter Terraform state."
  type = list(object({
    env_name   = string
    secret_arn = string
  }))
  default = []

  validation {
    condition = alltrue([
      for ref in var.runtime_secret_env_refs : can(regex("^arn:aws[a-zA-Z-]*:secretsmanager:", ref.secret_arn))
    ])
    error_message = "Every runtime_secret_env_refs.secret_arn must be a Secrets Manager ARN."
  }
}

variable "secret_kms_key_arns" {
  description = "KMS key ARNs encrypting referenced runtime secrets, if customer-managed."
  type        = list(string)
  default     = []
}

variable "environment" {
  description = "Non-secret environment variables injected into every Gantry container. GANTRY_PROCESS_ROLE and GANTRY_CONTROL_PORT are added per service."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for name in keys(var.environment) : !contains(["GANTRY_PROCESS_ROLE", "GANTRY_CONTROL_PORT"], name)
    ])
    error_message = "environment must not override GANTRY_PROCESS_ROLE or GANTRY_CONTROL_PORT."
  }
}

variable "task_policy_arns" {
  description = "Additional IAM policy ARNs attached to every ECS task role, such as read-only artifact bucket access."
  type        = list(string)
  default     = []
}

variable "task_policy_arns_by_role" {
  description = "Additional IAM policy ARNs attached only to the matching role task role, keyed by control, live-worker, and job-worker."
  type        = map(list(string))
  default     = {}
}

variable "ec2_capacity_providers" {
  description = "Optional EC2 capacity providers to create from existing Auto Scaling Groups. Managed scaling lets pending ECS tasks trigger instance scale-out."
  type = map(object({
    auto_scaling_group_arn         = string
    managed_scaling_status         = optional(string, "ENABLED")
    managed_scaling_target_capacity = optional(number, 80)
    managed_termination_protection = optional(string, "DISABLED")
  }))
  default = {}
}

variable "external_capacity_provider_names" {
  description = "Existing EC2 ECS capacity provider names to associate with the cluster."
  type        = list(string)
  default     = []
}

variable "default_capacity_provider_strategy" {
  description = "Default capacity-provider strategy used when a service does not override it. Empty falls back to EC2 launch type."
  type = list(object({
    capacity_provider = string
    weight            = optional(number, 1)
    base              = optional(number, 0)
  }))
  default = []
}

variable "service_capacity_provider_strategy" {
  description = "Per-role capacity-provider strategies keyed by control, live-worker, and job-worker."
  type = map(list(object({
    capacity_provider = string
    weight            = optional(number, 1)
    base              = optional(number, 0)
  })))
  default = {}
}

variable "service_configs" {
  description = "Per-role task and autoscaling settings keyed by control, live-worker, and job-worker."
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

  validation {
    condition     = alltrue([for role in ["control", "live-worker", "job-worker"] : contains(keys(var.service_configs), role)])
    error_message = "service_configs must include control, live-worker, and job-worker entries."
  }

  validation {
    condition = alltrue([
      for role, config in var.service_configs :
      config.min_capacity <= config.desired_count && config.desired_count <= config.max_capacity
    ])
    error_message = "Each service config must satisfy min_capacity <= desired_count <= max_capacity."
  }

  validation {
    condition = alltrue([
      for role, config in var.service_configs :
      config.cpu_target_value >= 10 && config.cpu_target_value <= 90
    ])
    error_message = "Each service config cpu_target_value must be between 10 and 90 percent."
  }
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

variable "docker_security_options" {
  description = "EC2-launch-type Docker security options. The default mirrors the ASG fleet's seccomp setting so sandbox_runtime/bubblewrap can create namespaces."
  type        = list(string)
  default     = ["seccomp=unconfined"]
}

variable "tags" {
  description = "Tags applied to resources in this module."
  type        = map(string)
  default     = {}
}
