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
variable "runtime_database_url_secret_arn" {
  description = "Secrets Manager ARN of the runtime DATABASE_URL secret (runtime role, RDS Proxy host, sslmode=require). Injected as GANTRY_DATABASE_URL."
  type        = string
}

variable "db_proxy_secret_arn" {
  description = "Secrets Manager ARN of the RDS Proxy runtime-role credential secret (JSON {username,password}). Referenced, never read into state."
  type        = string
}

variable "secret_encryption_key_secret_arn" {
  description = "Secrets Manager ARN of the SECRET_ENCRYPTION_KEY secret (base64-encoded 32-byte key). Required by the production security gate."
  type        = string

  validation {
    condition     = trimspace(var.secret_encryption_key_secret_arn) != ""
    error_message = "secret_encryption_key_secret_arn is required for support deployments."
  }
}

variable "gantry_ipc_auth_secret_arn" {
  description = "Secrets Manager ARN of the GANTRY_IPC_AUTH_SECRET secret (strong runner IPC secret). Required by the production security gate."
  type        = string

  validation {
    condition     = trimspace(var.gantry_ipc_auth_secret_arn) != ""
    error_message = "gantry_ipc_auth_secret_arn is required for support deployments."
  }
}

variable "gantry_control_api_keys_json_secret_arn" {
  description = "Secrets Manager ARN of the GANTRY_CONTROL_API_KEYS_JSON secret (JSON array with at least one strong key and non-empty scopes). Required by the production security gate."
  type        = string

  validation {
    condition     = trimspace(var.gantry_control_api_keys_json_secret_arn) != ""
    error_message = "gantry_control_api_keys_json_secret_arn is required for support deployments."
  }
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
  description = "ACM certificate ARN for the ALB HTTPS listener. Required because support exposes Gantry control/webhook ingress."
  type        = string

  validation {
    condition     = trimspace(var.certificate_arn) != ""
    error_message = "certificate_arn is required for support deployments."
  }
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
