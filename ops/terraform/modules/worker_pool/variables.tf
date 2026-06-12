variable "name_prefix" {
  description = "Prefix for resource names and Name tags (e.g. \"gantry-fleet\")."
  type        = string
}

variable "vpc_id" {
  description = "VPC the worker instances run in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs the ASG launches instances into."
  type        = list(string)
}

variable "image_ref" {
  description = "Fully-qualified container image reference (registry/repo:tag or @digest) the workers run. Pin by digest in production for reproducible instance refresh."
  type        = string
}

variable "ami_id" {
  description = "AMI ID for worker instances. Use a current Amazon Linux 2023 x86_64/arm64 AMI matching instance_type's architecture. VERIFY the AMI is current in your region (the user_data installs Docker via dnf/yum)."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for workers. Architecture must match ami_id."
  type        = string
  default     = "t3.large"
}

variable "control_port" {
  description = "Container control port (GANTRY_CONTROL_PORT). Must match the control module's target group port."
  type        = number
  default     = 8080
}

variable "process_role" {
  description = "Deployment-owned process role surfaced to the runtime as GANTRY_PROCESS_ROLE. One image, many roles: \"all\" (everything; the minimal support stack), \"control\" (admin/settings API, no execution), \"live-worker\" (live admission/execution + provider inbound, ops-only API), \"job-worker\" (scheduler + bakes, ops-only API). Also names the ASG (name_prefix-process_role)."
  type        = string
  default     = "all"

  validation {
    condition     = contains(["all", "control", "live-worker", "job-worker"], var.process_role)
    error_message = "process_role must be one of: all, control, live-worker, job-worker."
  }
}

variable "min_size" {
  description = "Minimum ASG size."
  type        = number
  default     = 1
}

variable "max_size" {
  description = "Maximum ASG size."
  type        = number
  default     = 3
}

variable "desired_capacity" {
  description = "Desired ASG size."
  type        = number
  default     = 1
}

variable "drain_deadline_seconds" {
  description = "Graceful drain deadline. Passed to docker --stop-timeout and used as the lifecycle-hook heartbeat timeout. Should be >= the runtime's SIGTERM drain deadline (default 120s)."
  type        = number
  default     = 130
}

variable "target_group_arns" {
  description = "ALB target group ARNs to register instances with (from the control module). Empty for job-only pools that take no public traffic."
  type        = list(string)
  default     = []
}

variable "alb_security_group_id" {
  description = "ALB security group ID allowed to reach the control port. Null/empty for pools that take no ALB traffic."
  type        = string
  default     = ""
}

variable "instance_policy_arns" {
  description = "IAM policy ARNs to attach to the worker instance role (e.g. artifact worker-ro from storage, runtime secret-read from secrets). The module additionally attaches SSM core and the self-managed lifecycle/secrets-read inline policy."
  type        = list(string)
  default     = []
}

variable "runtime_secret_env_refs" {
  description = "Runtime secrets to inject as env vars at boot: list of { env_name, secret_arn }. The instance fetches each from Secrets Manager into a 0600 env file (no secret values in Terraform state or the AMI). E.g. [{ env_name = \"GANTRY_DATABASE_URL\", secret_arn = \"arn:...\" }]."
  type = list(object({
    env_name   = string
    secret_arn = string
  }))
  default = []
}

variable "artifact_bucket_name" {
  description = "S3 artifact bucket name seeded into fleet settings.yaml for runtime.artifact_store."
  type        = string
}

variable "min_healthy_percentage" {
  description = "Instance refresh minimum healthy percentage during a rolling image update."
  type        = number
  default     = 50
}

variable "autoscaling_enabled" {
  description = "Attach a CPU target-tracking scaling policy to the ASG. Default true (the fleet's single worker pool; the live-turn host lease elects which instance hosts live turns). Set false for fixed-size pools such as the minimal support stack (min=max=1)."
  type        = bool
  default     = true
}

variable "cpu_target_value" {
  description = "Average CPU utilization (percent) the target-tracking policy holds the pool at. Lower scales out earlier. Only used when autoscaling_enabled."
  type        = number
  default     = 60

  validation {
    condition     = var.cpu_target_value >= 10 && var.cpu_target_value <= 90
    error_message = "cpu_target_value must be between 10 and 90 percent."
  }
}

variable "scaling_warmup_seconds" {
  description = "estimated_instance_warmup for the scaling policy: how long a new instance's metrics are excluded from the target-tracking average. Must cover boot + Docker install + image pull + migration + /readyz green, or the scaler over-provisions. Only used when autoscaling_enabled."
  type        = number
  default     = 180
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
