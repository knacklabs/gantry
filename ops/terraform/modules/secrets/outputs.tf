output "runtime_secret_read_policy_arn" {
  description = "IAM policy ARN granting read access to the worker runtime secret ARNs. Null when no runtime secrets were provided. Attach to the worker instance role."
  value       = length(aws_iam_policy.runtime_secret_read) > 0 ? aws_iam_policy.runtime_secret_read[0].arn : null
}

output "proxy_role_arn" {
  description = "ARN of the IAM role the RDS Proxy assumes to read the DB credential secret. Pass to the database module's proxy_role_arn."
  value       = aws_iam_role.proxy.arn
}
