output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_names" {
  description = "ECS service names keyed by Gantry process role."
  value       = { for role, service in aws_ecs_service.service : role => service.name }
}

output "task_definition_arns" {
  description = "ECS task definition ARNs keyed by Gantry process role."
  value       = { for role, task in aws_ecs_task_definition.service : role => task.arn }
}

output "security_group_id" {
  description = "Security group shared by the ECS services. Pass to the database module's ingress_security_group_ids."
  value       = aws_security_group.service.id
}

output "task_role_arns" {
  description = "Task role ARNs for runtime AWS access, keyed by Gantry process role."
  value       = { for role, task_role in aws_iam_role.task : role => task_role.arn }
}

output "task_execution_role_arn" {
  description = "Task execution role ARN that reads task-definition secrets."
  value       = aws_iam_role.task_execution.arn
}
