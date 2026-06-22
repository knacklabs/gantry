output "alb_dns_name" {
  description = "Public ALB DNS name for deployment types with a control service. Null for jobs-only."
  value       = local.has_control ? module.control[0].alb_dns_name : null
}

output "artifacts_bucket" {
  description = "S3 bucket holding capability artifacts."
  value       = module.storage.bucket_name
}

output "database_proxy_endpoint" {
  description = "RDS Proxy endpoint host. The runtime DATABASE_URL secret should target this host."
  value       = module.database.proxy_endpoint
}

output "database_endpoint" {
  description = "Direct RDS endpoint host."
  value       = module.database.endpoint
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs.cluster_name
}

output "ecs_service_names" {
  description = "ECS service names keyed by Gantry process role."
  value       = module.ecs.service_names
}

output "ecs_capacity_asg" {
  description = "Name of the ECS container instance ASG managed by the ECS capacity provider."
  value       = module.ecs_capacity.asg_name
}
