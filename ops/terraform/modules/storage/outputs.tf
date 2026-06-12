output "bucket_name" {
  description = "Name of the artifacts bucket. Pass to the runtime as the artifact store location."
  value       = aws_s3_bucket.artifacts.bucket
}

output "bucket_arn" {
  description = "ARN of the artifacts bucket."
  value       = aws_s3_bucket.artifacts.arn
}

output "bake_rw_policy_arn" {
  description = "IAM policy ARN granting read-write artifact access. Attach to the bake job role only."
  value       = aws_iam_policy.bake_rw.arn
}

output "worker_ro_policy_arn" {
  description = "IAM policy ARN granting read-only artifact access. Attach to the worker instance role."
  value       = aws_iam_policy.worker_ro.arn
}

output "worker_browser_rw_policy_arn" {
  description = "IAM policy ARN granting worker read-write access to browser profile snapshots."
  value       = aws_iam_policy.worker_browser_rw.arn
}
