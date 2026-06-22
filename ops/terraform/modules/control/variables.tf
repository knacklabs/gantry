variable "name_prefix" {
  description = "Prefix for resource names and Name tags (e.g. \"gantry-fleet\")."
  type        = string
}

variable "vpc_id" {
  description = "VPC the ALB and target group live in."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for the internet-facing ALB (>=2 AZs)."
  type        = list(string)
}

variable "control_port" {
  description = "Container control port (GANTRY_CONTROL_PORT) the runtime listens on. The ALB target group forwards to this port."
  type        = number
  default     = 8080
}

variable "target_type" {
  description = "ALB target type for the control/live target groups. Use instance for ASG worker pools and ip for ECS awsvpc services."
  type        = string
  default     = "instance"

  validation {
    condition     = contains(["instance", "ip"], var.target_type)
    error_message = "target_type must be instance or ip."
  }
}

variable "api_path_patterns" {
  description = "Path patterns the PUBLIC listener forwards to the CONTROL target group (admin/settings API, SDK session messages, external ingress). Only the control role serves these; worker roles 404 admin routes. Operational endpoints (/metrics, /readyz, /healthz) are deliberately excluded from the public listener — health endpoints are reachable only via the target-group health check, and /metrics stays internal."
  type        = list(string)
  default     = ["/v1/*"]
}

variable "webhook_path_patterns" {
  description = "Path patterns the PUBLIC listener forwards to the LIVE target group (provider inbound webhooks). The live-worker role owns providerInbound. Most provider inbound is worker-initiated polling/socket (no ALB hop) today; this pattern is the correct home for HTTP webhook ingress as it lands."
  type        = list(string)
  default     = ["/webhooks/*"]
}

variable "enable_webhook_paths" {
  description = "Forward webhook_path_patterns to the live target group. Disable for ECS deployment types where only the control service may attach a public target group."
  type        = bool
  default     = true
}

variable "health_check_path" {
  description = "Target-group health check path. /readyz returns 503 while draining or before migrations/settings load, so the ALB stops routing to draining workers."
  type        = string
  default     = "/readyz"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the HTTPS listener. Required for any public Gantry control/webhook ingress."
  type        = string

  validation {
    condition     = trimspace(var.certificate_arn) != ""
    error_message = "certificate_arn is required; public Gantry control/webhook ingress must not run over plain HTTP."
  }
}

variable "ingress_cidrs" {
  description = "CIDR blocks allowed to reach the public listener. Default is open (0.0.0.0/0) because channel webhooks come from provider IP ranges; tighten where the provider publishes ranges."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "deregistration_delay_seconds" {
  description = "ALB connection draining window on target deregistration. Should be <= the worker drain deadline so the ALB stops sending new connections while the worker finishes in-flight work."
  type        = number
  default     = 120
}

variable "idle_timeout_seconds" {
  description = "ALB idle timeout. Raise for long-lived SSE/streaming responses."
  type        = number
  default     = 300
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
