# Database module: RDS PostgreSQL (pgvector-enabled), behind RDS Proxy to bound
# connection count under a scaling worker fleet. The master password is managed
# by RDS/Secrets Manager so no database password value enters Terraform state.

locals {
  postgres_port = 5432
  family        = "postgres${split(".", var.engine_version)[0]}"
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.subnet_ids
  tags       = merge(var.tags, { Name = "${var.name_prefix}-db-subnet-group" })
}

# Security group: only the worker pool SG may reach Postgres.
resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db"
  description = "Gantry RDS/Proxy ingress from worker pool only"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-db-sg" })
}

resource "aws_security_group_rule" "db_ingress_workers" {
  count                    = length(var.ingress_security_group_ids)
  type                     = "ingress"
  from_port                = local.postgres_port
  to_port                  = local.postgres_port
  protocol                 = "tcp"
  security_group_id        = aws_security_group.db.id
  source_security_group_id = var.ingress_security_group_ids[count.index]
  description              = "Postgres from worker pool"
}

# Proxy needs to reach the DB SG; DB SG must accept the proxy. Self-reference
# keeps proxy<->db traffic inside the same SG.
resource "aws_security_group_rule" "db_ingress_self" {
  type              = "ingress"
  from_port         = local.postgres_port
  to_port           = local.postgres_port
  protocol          = "tcp"
  security_group_id = aws_security_group.db.id
  self              = true
  description       = "Postgres within DB/proxy SG (RDS Proxy to RDS)"
}

resource "aws_security_group_rule" "db_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.db.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow all egress (Secrets Manager endpoint, etc.)"
}

# Parameter group: shared_preload_libraries is not required for pgvector
# (it is a plain extension), but we keep an explicit group so operators can tune
# without recreating the instance. The runtime CREATE EXTENSION vector at
# migration time installs pgvector on a supported engine version.
resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name_prefix}-pg-"
  family      = local.family
  description = "Gantry RDS parameters (pgvector-capable engine line)"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-pg-params" })
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name_prefix}-pg"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                     = var.database_name
  username                    = var.master_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  port                   = local.postgres_port

  multi_az                  = var.multi_az
  backup_retention_period   = var.backup_retention_days
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name_prefix}-pg-final" : null
  apply_immediately         = false
  copy_tags_to_snapshot     = true

  tags = merge(var.tags, { Name = "${var.name_prefix}-pg" })
}

# --- RDS Proxy: bounds total DB connections under a scaling worker fleet. ---
data "aws_iam_policy_document" "proxy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name               = "${var.name_prefix}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "proxy_secret_read" {
  statement {
    sid       = "ReadProxySecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [var.proxy_secret_arn]
  }

  dynamic "statement" {
    for_each = length(var.kms_key_arns) > 0 ? [1] : []
    content {
      sid       = "DecryptProxySecretKms"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = var.kms_key_arns
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${data.aws_region.current.name}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "proxy_secret_read" {
  name   = "${var.name_prefix}-rds-proxy-secret-read"
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy_secret_read.json
}

resource "aws_db_proxy" "this" {
  name                   = "${var.name_prefix}-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.db.id]
  require_tls            = true
  idle_client_timeout    = 1800

  auth {
    auth_scheme = "SECRETS"
    secret_arn  = var.proxy_secret_arn
    iam_auth    = "DISABLED"
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-proxy" })
}

resource "aws_db_proxy_default_target_group" "this" {
  db_proxy_name = aws_db_proxy.this.name

  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
  }
}

data "aws_region" "current" {}

resource "aws_db_proxy_target" "this" {
  db_proxy_name          = aws_db_proxy.this.name
  target_group_name      = aws_db_proxy_default_target_group.this.name
  db_instance_identifier = aws_db_instance.this.identifier
}
