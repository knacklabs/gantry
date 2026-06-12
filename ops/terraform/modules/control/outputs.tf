output "alb_dns_name" {
  description = "Public DNS name of the ALB. Point channel webhooks and API clients here."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Route53 hosted zone ID of the ALB (for alias records)."
  value       = aws_lb.this.zone_id
}

output "alb_arn" {
  description = "ARN of the ALB."
  value       = aws_lb.this.arn
}

output "control_target_group_arn" {
  description = "ARN of the control target group (receives /v1/*). Wire the control role's worker pool ASG to this. Single-pool `all` stacks wire their one worker to both target groups."
  value       = aws_lb_target_group.control.arn
}

output "live_target_group_arn" {
  description = "ARN of the live target group (receives /webhooks/*). Wire the live-worker role's worker pool ASG to this. Single-pool `all` stacks wire their one worker to both target groups."
  value       = aws_lb_target_group.live.arn
}

output "alb_security_group_id" {
  description = "Security group of the ALB. The worker pool must allow ingress on the control port from this SG."
  value       = aws_security_group.alb.id
}
