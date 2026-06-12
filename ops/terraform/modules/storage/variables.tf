variable "name_prefix" {
  description = "Prefix for resource names and Name tags (e.g. \"gantry-fleet\")."
  type        = string
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket name for capability artifacts (skills/, toolchains/). If empty, a name is derived from name_prefix plus a random suffix."
  type        = string
  default     = ""
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete a non-empty bucket. True only for throwaway rehearsals; false for fleet/support so artifacts are not lost accidentally."
  type        = bool
  default     = false
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which noncurrent object versions are expired. Artifacts are current-state (no app-level versioning), so this only reaps S3's own version history kept for accidental-overwrite recovery."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
