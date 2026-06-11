variable "region" {
  description = "AWS region for the fleet stack. VERIFY the chosen RDS engine version and AMI exist in this region."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for all resource names (e.g. \"gantry-fleet\")."
  type        = string
  default     = "gantry-fleet"
}

variable "image_ref" {
  description = "Container image the workers run (registry/repo:tag or @digest). Pin by digest in production. Built/pushed by .github/workflows/image.yml to GHCR; mirror to ECR or grant pull access as needed."
  type        = string
}

variable "worker_ami_id" {
  description = "Amazon Linux 2023 AMI ID for worker instances (architecture must match instance types). VERIFY current AMI per region; SSM public parameter /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 resolves the latest."
  type        = string
}

# --- Secret REFERENCES (ARNs). Create the secret values out-of-band before
#     apply (see runbook). No secret values appear here or in state. ---

variable "db_master_password_secret_arn" {
  description = "Secrets Manager ARN of the RDS master password (plaintext secret string)."
  type        = string
}

variable "db_proxy_secret_arn" {
  description = "Secrets Manager ARN of the RDS Proxy credential secret (JSON {username,password})."
  type        = string
}

variable "runtime_database_url_secret_arn" {
  description = "Secrets Manager ARN of the runtime DATABASE_URL secret (full postgres://... URL targeting the RDS Proxy endpoint, with the RUNTIME role and sslmode=require). Injected into workers as GANTRY_DATABASE_URL."
  type        = string
}

variable "migration_database_url_secret_arn" {
  description = "Optional Secrets Manager ARN of the MIGRATION DATABASE_URL secret (migration role; may differ from runtime role). When set, injected as MIGRATION_DATABASE_URL so the entrypoint migrates with the migration role. Empty string disables (runtime role migrates)."
  type        = string
  default     = ""
}

variable "additional_runtime_secret_refs" {
  description = "Extra runtime secrets to inject into workers as env vars: list of { env_name, secret_arn }. Use for channel/provider credentials and control API keys (e.g. { env_name = \"GANTRY_CONTROL_API_KEYS_JSON\", secret_arn = \"arn:...\" })."
  type = list(object({
    env_name   = string
    secret_arn = string
  }))
  default = []
}

variable "secret_kms_key_arns" {
  description = "KMS key ARNs encrypting the referenced secrets, if customer-managed. Empty when using the AWS-managed aws/secretsmanager key."
  type        = list(string)
  default     = []
}

# --- Database sizing. ---
variable "db_engine_version" {
  description = "RDS PostgreSQL engine version (must support pgvector 0.8.x). VERIFY availability in the region."
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

# --- Worker pool sizing (fleet v1 topology: 1 live host + N job workers). ---
variable "live_worker_instance_type" {
  description = "Instance type for the singleton live-host worker."
  type        = string
  default     = "t3.large"
}

variable "job_worker_instance_type" {
  description = "Instance type for job workers."
  type        = string
  default     = "t3.large"
}

variable "job_worker_min_size" {
  description = "Minimum job-worker ASG size."
  type        = number
  default     = 1
}

variable "job_worker_max_size" {
  description = "Maximum job-worker ASG size."
  type        = number
  default     = 4
}

variable "job_worker_desired_capacity" {
  description = "Desired job-worker ASG size."
  type        = number
  default     = 2
}

# --- Ingress. ---
variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener. Empty creates an HTTP-only listener (acceptable for early rehearsal; set for production)."
  type        = string
  default     = ""
}

variable "drain_deadline_seconds" {
  description = "Graceful drain deadline for workers (docker --stop-timeout + lifecycle heartbeat). >= the runtime SIGTERM drain deadline (120s default)."
  type        = number
  default     = 130
}

variable "tags" {
  description = "Extra tags merged into the provider default_tags."
  type        = map(string)
  default     = {}
}
