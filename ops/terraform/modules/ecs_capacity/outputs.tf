output "asg_arn" {
  description = "ARN of the ECS container instance Auto Scaling Group."
  value       = aws_autoscaling_group.instance.arn
}

output "asg_name" {
  description = "Name of the ECS container instance Auto Scaling Group."
  value       = aws_autoscaling_group.instance.name
}

output "security_group_id" {
  description = "Security group of the ECS container instances."
  value       = aws_security_group.instance.id
}

output "instance_role_arn" {
  description = "ARN of the ECS container instance IAM role."
  value       = aws_iam_role.instance.arn
}
