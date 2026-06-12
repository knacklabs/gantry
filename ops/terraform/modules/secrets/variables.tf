variable "name_prefix" {
  description = "Prefix for resource names and Name tags (e.g. \"gantry-fleet\")."
  type        = string
}

variable "runtime_secret_arns" {
  description = "ARNs of pre-created Secrets Manager secrets the WORKER runtime must read (e.g. the runtime DATABASE_URL secret, channel/provider credential secrets, control API keys). Created out-of-band; this module only grants read access by ARN. No secret VALUES enter Terraform state."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.runtime_secret_arns : can(regex("^arn:aws[a-zA-Z-]*:secretsmanager:", arn))
    ])
    error_message = "Every entry in runtime_secret_arns must be a Secrets Manager ARN (arn:aws:secretsmanager:...)."
  }
}

variable "kms_key_arns" {
  description = "ARNs of KMS keys that encrypt the referenced secrets, if they use a customer-managed key. Grants kms:Decrypt to the readers. Leave empty when secrets use the AWS-managed aws/secretsmanager key."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
