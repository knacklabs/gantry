output "alb_dns_name" {
  description = "Public ALB DNS name. Point channel webhooks and API clients here (HTTPS when a certificate is configured)."
  value       = module.control.alb_dns_name
}

output "artifacts_bucket" {
  description = "S3 bucket holding capability artifacts (skills/, toolchains/)."
  value       = module.storage.bucket_name
}

output "database_proxy_endpoint" {
  description = "RDS Proxy endpoint host. The runtime DATABASE_URL secret should target this host."
  value       = module.database.proxy_endpoint
}

output "database_endpoint" {
  description = "Direct RDS endpoint host (for admin/migration access from a bastion if not using the proxy)."
  value       = module.database.endpoint
}

output "live_worker_asg" {
  description = "Name of the live-host worker ASG."
  value       = module.live_worker.asg_name
}

output "job_worker_asg" {
  description = "Name of the job-worker ASG."
  value       = module.job_worker.asg_name
}
