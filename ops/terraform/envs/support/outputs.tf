output "alb_dns_name" {
  description = "Public ALB DNS name for the support stack."
  value       = module.control.alb_dns_name
}

output "artifacts_bucket" {
  description = "S3 bucket holding pre-provisioned capability artifacts for the locked support agent."
  value       = module.storage.bucket_name
}

output "database_proxy_endpoint" {
  description = "RDS Proxy endpoint host. The runtime DATABASE_URL secret should target this host."
  value       = module.database.proxy_endpoint
}

output "database_endpoint" {
  description = "Direct RDS endpoint (for migration/seeding access from a bastion)."
  value       = module.database.endpoint
}

output "worker_asg" {
  description = "Name of the single support worker ASG."
  value       = module.worker.asg_name
}
