# Locked support stack: an isolated, minimal fleet variant. One worker, locked
# agents only (access.preset: locked, seeded via `gantry settings import`). The
# locked posture is enforced parent-side in the runtime; this env just sizes the
# stack down and keeps it isolated (separate state, separate VPC).

variable "region" {
  description = "AWS region for the support stack. VERIFY the RDS engine version and AMI exist here."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for all resource names (e.g. \"gantry-support\")."
  type        = string
  default     = "gantry-support"
}

variable "image_ref" {
  description = "Container image the support worker runs (registry/repo:tag or @digest). Pin by digest in production."
  type        = string
}

variable "worker_ami_id" {
  description = "Amazon Linux 2023 AMI ID for the worker instance. VERIFY current AMI per region."
  type        = string
}

# --- Secret REFERENCES (ARNs) only. Create values out-of-band before apply. ---
variable "db_master_password_secret_arn" {
  description = "Secrets Manager ARN of the RDS master password."
  type        = string
}

variable "db_proxy_secret_arn" {
  description = "Secrets Manager ARN of the RDS Proxy credential secret (JSON {username,password})."
  type        = string
}

variable "runtime_database_url_secret_arn" {
  description = "Secrets Manager ARN of the runtime DATABASE_URL secret (runtime role, RDS Proxy host, sslmode=require). Injected as GANTRY_DATABASE_URL."
  type        = string
}

variable "migration_database_url_secret_arn" {
  description = "Optional Secrets Manager ARN of the migration-role DATABASE_URL. Injected as MIGRATION_DATABASE_URL when set."
  type        = string
  default     = ""
}

variable "additional_runtime_secret_refs" {
  description = "Extra runtime secrets to inject as env vars: list of { env_name, secret_arn } (channel/provider credentials, control API keys)."
  type = list(object({
    env_name   = string
    secret_arn = string
  }))
  default = []
}

variable "secret_kms_key_arns" {
  description = "KMS key ARNs encrypting referenced secrets, if customer-managed. Empty for the AWS-managed key."
  type        = list(string)
  default     = []
}

variable "db_engine_version" {
  description = "RDS PostgreSQL engine version (pgvector 0.8.x capable). VERIFY in the region."
  type        = string
  default     = "16.8"
}

variable "db_instance_class" {
  description = "RDS instance class for the minimal support DB."
  type        = string
  default     = "db.t4g.small"
}

variable "worker_instance_type" {
  description = "Instance type for the single support worker."
  type        = string
  default     = "t3.medium"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener. Empty creates HTTP-only (rehearsal)."
  type        = string
  default     = ""
}

variable "drain_deadline_seconds" {
  description = "Graceful drain deadline for the worker."
  type        = number
  default     = 130
}

variable "tags" {
  description = "Extra tags merged into provider default_tags."
  type        = map(string)
  default     = {}
}
