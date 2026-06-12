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

variable "runtime_database_url_secret_arn" {
  description = "Secrets Manager ARN of the runtime DATABASE_URL secret (full postgres://... URL targeting the RDS Proxy endpoint, with the RUNTIME role and sslmode=require). Injected into workers as GANTRY_DATABASE_URL."
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
    error_message = "secret_encryption_key_secret_arn is required for fleet deployments."
  }
}

variable "gantry_ipc_auth_secret_arn" {
  description = "Secrets Manager ARN of the GANTRY_IPC_AUTH_SECRET secret (strong runner IPC secret). Required by the production security gate."
  type        = string

  validation {
    condition     = trimspace(var.gantry_ipc_auth_secret_arn) != ""
    error_message = "gantry_ipc_auth_secret_arn is required for fleet deployments."
  }
}

variable "gantry_control_api_keys_json_secret_arn" {
  description = "Secrets Manager ARN of the GANTRY_CONTROL_API_KEYS_JSON secret (JSON array with at least one strong key and non-empty scopes). Required by the production security gate."
  type        = string

  validation {
    condition     = trimspace(var.gantry_control_api_keys_json_secret_arn) != ""
    error_message = "gantry_control_api_keys_json_secret_arn is required for fleet deployments."
  }
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

# --- Worker pools (role-differentiated: control + live-worker + job-worker).
#     One image, GANTRY_PROCESS_ROLE per pool. ---

# Control pool (admin/settings API; /v1/* ingress; no execution).
variable "control_instance_type" {
  description = "Instance type for the control pool. The control plane is light (API + settings writes, no agent runners), so a smaller class than the worker pools is fine."
  type        = string
  default     = "t3.medium"
}

variable "control_min_size" {
  description = "Minimum control ASG size. Default 1 (single control plane). Raise to 2 only if you need control-plane availability across an AZ failure."
  type        = number
  default     = 1
}

variable "control_max_size" {
  description = "Maximum control ASG size."
  type        = number
  default     = 2
}

variable "control_desired_capacity" {
  description = "Initial desired control ASG size."
  type        = number
  default     = 1
}

variable "control_autoscaling_enabled" {
  description = "Attach CPU target tracking to the control pool. Default false — the control plane rarely needs to autoscale; execution lives on the worker roles."
  type        = bool
  default     = false
}

variable "control_cpu_target" {
  description = "Average CPU percent the control pool is held at by target tracking (only used when control_autoscaling_enabled)."
  type        = number
  default     = 60
}

# Live-worker pool (distributed live admission/execution; /webhooks/* ingress).
variable "live_worker_instance_type" {
  description = "Instance type for live workers. Size by concurrent live turns per instance (memory is the limit — see the runbook's Sizing and scaling). Live capacity is per-worker max_message_runs, so more instances add chat capacity linearly."
  type        = string
  default     = "t3.large"
}

variable "live_worker_min_size" {
  description = "Minimum live-worker ASG size. Must be >= 2: a warm pool for live capacity plus recovery-coordinator failover (the coordinator lease re-elects onto any live worker on drain; RTO ~= lease TTL, ~30s)."
  type        = number
  default     = 2

  validation {
    condition     = var.live_worker_min_size >= 2
    error_message = "live_worker_min_size must be >= 2 in the fleet env (warm live capacity + recovery-coordinator failover). Single-worker stacks belong in envs/support."
  }
}

variable "live_worker_max_size" {
  description = "Maximum live-worker ASG size."
  type        = number
  default     = 6
}

variable "live_worker_desired_capacity" {
  description = "Initial desired live-worker ASG size. Once autoscaling is enabled the policy owns desired capacity (Terraform ignores drift); steer a running pool via min/max."
  type        = number
  default     = 2
}

variable "live_worker_autoscaling_enabled" {
  description = "Attach the CPU target-tracking policy so the live pool scales between min and max. Scale-in drains via the lifecycle hook; a terminated recovery coordinator re-elects onto a standby (loss-free, ~lease-TTL blip)."
  type        = bool
  default     = true
}

variable "live_worker_cpu_target" {
  description = "Average CPU percent the live pool is held at by target tracking. Lower scales out earlier (10-90)."
  type        = number
  default     = 60
}

# Job-worker pool (scheduler + bakes; no ALB traffic).
variable "job_worker_instance_type" {
  description = "Instance type for job workers. Size by concurrent job/bake runners (max_job_runs) and memory per runner."
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
  description = "Initial desired job-worker ASG size. Once autoscaling is enabled the policy owns desired capacity (Terraform ignores drift); steer a running pool via min/max."
  type        = number
  default     = 1
}

variable "job_worker_autoscaling_enabled" {
  description = "Attach the CPU target-tracking policy so the job pool scales between min and max on job/bake load."
  type        = bool
  default     = true
}

variable "job_worker_cpu_target" {
  description = "Average CPU percent the job pool is held at by target tracking. Lower scales out earlier (10-90)."
  type        = number
  default     = 60
}

# --- Ingress. ---
variable "certificate_arn" {
  description = "ACM certificate ARN for the ALB HTTPS listener. Required because fleet exposes Gantry control/webhook ingress."
  type        = string

  validation {
    condition     = trimspace(var.certificate_arn) != ""
    error_message = "certificate_arn is required for fleet deployments."
  }
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
