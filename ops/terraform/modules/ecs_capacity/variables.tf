variable "name_prefix" {
  description = "Prefix for ECS capacity resource names and Name tags."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name the instances join."
  type        = string
}

variable "vpc_id" {
  description = "VPC the ECS container instances run in."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for ECS container instances."
  type        = list(string)
}

variable "ami_id" {
  description = "ECS-optimized AMI ID. Empty resolves the latest Amazon Linux 2023 ECS-optimized AMI from SSM."
  type        = string
  default     = ""
}

variable "ami_ssm_parameter" {
  description = "SSM public parameter for the ECS-optimized AMI when ami_id is empty."
  type        = string
  default     = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

variable "instance_type" {
  description = "EC2 instance type for ECS container instances. Use enough memory for the configured sandbox concurrency."
  type        = string
  default     = "c7i.2xlarge"
}

variable "min_size" {
  description = "Minimum ECS container instance ASG size."
  type        = number
  default     = 1
}

variable "max_size" {
  description = "Maximum ECS container instance ASG size."
  type        = number
  default     = 6
}

variable "desired_capacity" {
  description = "Initial desired ECS container instance count. ECS managed scaling owns this after apply."
  type        = number
  default     = 2
}

variable "root_volume_gb" {
  description = "Root EBS volume size in GiB for image layers, workspaces, sandbox temp dirs, and artifact cache."
  type        = number
  default     = 80
}

variable "tags" {
  description = "Tags applied to resources in this module."
  type        = map(string)
  default     = {}
}
