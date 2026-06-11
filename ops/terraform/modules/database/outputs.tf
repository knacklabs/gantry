output "endpoint" {
  description = "Direct RDS instance endpoint (host). Prefer proxy_endpoint for runtime connections."
  value       = aws_db_instance.this.address
}

output "proxy_endpoint" {
  description = "RDS Proxy endpoint host. Runtime DATABASE_URL should target this to bound connection count."
  value       = aws_db_proxy.this.endpoint
}

output "port" {
  description = "Postgres port."
  value       = local.postgres_port
}

output "database_name" {
  description = "Initial database name."
  value       = var.database_name
}

output "security_group_id" {
  description = "Security group protecting the database and proxy."
  value       = aws_security_group.db.id
}

output "instance_identifier" {
  description = "RDS instance identifier (for instance refresh / maintenance references)."
  value       = aws_db_instance.this.identifier
}
