output "asg_name" {
  description = "Name of the Auto Scaling Group."
  value       = aws_autoscaling_group.worker.name
}

output "security_group_id" {
  description = "Security group of the worker instances. Pass to the database module's ingress_security_group_ids so workers can reach Postgres/Proxy."
  value       = aws_security_group.worker.id
}

output "instance_role_arn" {
  description = "ARN of the worker instance IAM role (for additional policy attachments if needed)."
  value       = aws_iam_role.worker.arn
}

output "instance_role_name" {
  description = "Name of the worker instance IAM role."
  value       = aws_iam_role.worker.name
}

output "launch_template_id" {
  description = "ID of the worker launch template."
  value       = aws_launch_template.worker.id
}
