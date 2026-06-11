variable "name_prefix" {
  description = "Prefix for all resource names and Name tags (e.g. \"gantry-fleet\")."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Must be large enough for the public and private subnets below."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of availability zones to spread subnets across (>=2 for ALB and RDS Multi-AZ)."
  type        = number
  default     = 2

  validation {
    condition     = var.availability_zone_count >= 2
    error_message = "availability_zone_count must be at least 2 for ALB and RDS subnet groups."
  }
}

variable "public_subnet_newbits" {
  description = "Additional CIDR bits for public subnets (cidrsubnet newbits). 8 -> /24 from a /16."
  type        = number
  default     = 8
}

variable "private_subnet_newbits" {
  description = "Additional CIDR bits for private subnets (cidrsubnet newbits). 8 -> /24 from a /16."
  type        = number
  default     = 8
}

variable "enable_nat_gateway" {
  description = "Create a NAT gateway so private workers can reach the internet (registry pulls, provider APIs). Disable only for fully air-gapped variants with VPC endpoints for every dependency."
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "Use one shared NAT gateway instead of one per AZ. Cheaper; trades AZ-independent egress. Recommended true for support (minimal) stacks."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
