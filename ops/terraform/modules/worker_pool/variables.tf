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

variable "worker_role" {
  description = "Logical worker role label, surfaced to the runtime as GANTRY_WORKER_ROLE (e.g. \"live\", \"job\"). Drives the 1 live-host + N job-workers topology."
  type        = string
  default     = "job"
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

variable "min_healthy_percentage" {
  description = "Instance refresh minimum healthy percentage during a rolling image update."
  type        = number
  default     = 50
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
