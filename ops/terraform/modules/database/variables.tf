variable "name_prefix" {
  description = "Prefix for all resource names and Name tags (e.g. \"gantry-fleet\")."
  type        = string
}

variable "vpc_id" {
  description = "VPC the database and proxy run in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for the DB subnet group and RDS Proxy (>=2 AZs)."
  type        = list(string)
}

variable "ingress_security_group_ids" {
  description = "Security group IDs allowed to connect to the database/proxy on the Postgres port (the worker pool SG)."
  type        = list(string)
}

variable "engine_version" {
  description = "RDS PostgreSQL engine version. Must support pgvector 0.8.x. As of 2026-06, supported lines include 16.5+, 15.9+, 17.1+. Defaults to the 16.x line to match the local pgvector/pgvector:pg16 image. VERIFY the exact available minor in your region with: aws rds describe-db-engine-versions --engine postgres --query 'DBEngineVersions[].EngineVersion'."
  type        = string
  default     = "16.8"
}

variable "instance_class" {
  description = "RDS instance class. Right-size per load; db.t4g.medium is a reasonable fleet default."
  type        = string
  default     = "db.t4g.medium"
}

variable "allocated_storage_gb" {
  description = "Initial allocated storage in GiB."
  type        = number
  default     = 50
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling in GiB. Set equal to allocated_storage_gb to disable autoscaling."
  type        = number
  default     = 200
}

variable "multi_az" {
  description = "Enable RDS Multi-AZ for failover. Recommended for fleet; may be false for minimal support stacks to save cost."
  type        = bool
  default     = true
}

variable "database_name" {
  description = "Initial database name created on the instance."
  type        = string
  default     = "gantry"
}

variable "master_username" {
  description = "Master username for the database. RDS manages the master password in Secrets Manager so the value never enters Terraform state."
  type        = string
  default     = "gantry_admin"
}

variable "deletion_protection" {
  description = "Block accidental terraform destroy of the database. True for fleet; consider false for throwaway support rehearsals."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Automated backup retention window in days."
  type        = number
  default     = 7
}

variable "proxy_secret_arn" {
  description = "ARN of the Secrets Manager secret (runtime DB username + password JSON) the RDS Proxy uses to authenticate runtime-role connections. Referenced, never read into state."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-zA-Z-]*:secretsmanager:", var.proxy_secret_arn))
    error_message = "proxy_secret_arn must be a Secrets Manager ARN."
  }
}

variable "kms_key_arns" {
  description = "KMS key ARNs encrypting the RDS Proxy credential secret, if customer-managed. Empty when using the AWS-managed aws/secretsmanager key."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
