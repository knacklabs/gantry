# Secrets module: ARN wiring ONLY. It creates no secret values and reads none
# into Terraform state. It produces:
#   - an IAM policy granting GetSecretValue on the worker runtime secret ARNs,
#   - an IAM role + policy the RDS Proxy assumes to read the DB credential secret.
# Secret values are created out-of-band (see docs/deployment/aws-terraform.md).

# --- Worker runtime secret-read policy (attached to the worker role in the
#     worker_pool module). Scoped to exactly the referenced ARNs. ---
data "aws_iam_policy_document" "runtime_secret_read" {
  count = length(var.runtime_secret_arns) > 0 ? 1 : 0

  statement {
    sid       = "ReadRuntimeSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = var.runtime_secret_arns
  }

  dynamic "statement" {
    for_each = length(var.kms_key_arns) > 0 ? [1] : []
    content {
      sid       = "DecryptSecretsKms"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = var.kms_key_arns
    }
  }
}

resource "aws_iam_policy" "runtime_secret_read" {
  count       = length(var.runtime_secret_arns) > 0 ? 1 : 0
  name        = "${var.name_prefix}-runtime-secret-read"
  description = "Read the referenced Gantry runtime secrets (by ARN; values never in state)."
  policy      = data.aws_iam_policy_document.runtime_secret_read[0].json
  tags        = var.tags
}

# --- RDS Proxy role: assumes rds.amazonaws.com, reads the DB credential secret. ---
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

data "aws_region" "current" {}
