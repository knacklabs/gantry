# Network module: VPC, public + private subnets across AZs, internet egress for
# public subnets, optional NAT for private subnets, and an S3 gateway endpoint
# so artifact traffic stays on the AWS backbone (no NAT cost, no public path).

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(
    data.aws_availability_zones.available.names,
    0,
    var.availability_zone_count,
  )
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = var.name_prefix })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count = var.availability_zone_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, var.public_subnet_newbits, count.index)
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-public-${count.index}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count = var.availability_zone_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  # Offset private subnet indices past the public block to avoid CIDR overlap.
  cidr_block = cidrsubnet(
    var.vpc_cidr,
    var.private_subnet_newbits,
    count.index + var.availability_zone_count,
  )

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-private-${count.index}"
    Tier = "private"
  })
}

# --- Public routing: straight to the internet gateway. ---
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-public-rt" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = var.availability_zone_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- NAT for private egress (optional). One per AZ unless single_nat_gateway. ---
locals {
  nat_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : var.availability_zone_count) : 0
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-nat-eip-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(var.tags, { Name = "${var.name_prefix}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count  = var.availability_zone_count
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-private-rt-${count.index}" })
}

resource "aws_route" "private_nat" {
  count                  = var.enable_nat_gateway ? var.availability_zone_count : 0
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  # With single_nat_gateway, all private route tables share NAT index 0.
  nat_gateway_id = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count          = var.availability_zone_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# --- S3 gateway endpoint: artifact (skills/toolchains) traffic on the AWS
#     backbone, attached to the private route tables. No NAT, no public path. ---
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = merge(var.tags, { Name = "${var.name_prefix}-s3-endpoint" })
}

data "aws_region" "current" {}
