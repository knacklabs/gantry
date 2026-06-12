# Storage module: one S3 bucket for capability artifacts and worker-authored
# browser profile snapshots. Capability artifact IAM stays split (bake-rw,
# worker-ro); browser profile snapshots are written by workers under a dedicated
# prefix.

resource "random_id" "suffix" {
  count       = var.bucket_name == "" ? 1 : 0
  byte_length = 4
}

locals {
  bucket_name = var.bucket_name != "" ? var.bucket_name : "${var.name_prefix}-artifacts-${random_id.suffix[0].hex}"
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Name = "${var.name_prefix}-artifacts" })
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioning kept on for accidental-overwrite recovery only. The application
# model is current-state replace-on-update (no versioned artifact store); the
# lifecycle rule below reaps old versions so this does not grow unbounded.
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# --- Split IAM policies. Attach bake-rw to the bake job role, worker-ro to the
#     worker instance role (see worker_pool / secrets modules for the roles). ---

data "aws_iam_policy_document" "bake_rw" {
  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["skills/*", "toolchains/*"]
    }
  }
  statement {
    sid    = "ObjectReadWrite"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/skills/*",
      "${aws_s3_bucket.artifacts.arn}/toolchains/*",
    ]
  }
}

data "aws_iam_policy_document" "worker_ro" {
  statement {
    sid       = "ListBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["skills/*", "toolchains/*"]
    }
  }
  statement {
    sid       = "ObjectReadOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/skills/*",
      "${aws_s3_bucket.artifacts.arn}/toolchains/*",
    ]
  }
}

data "aws_iam_policy_document" "worker_browser_rw" {
  statement {
    sid       = "ListBrowserProfiles"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["browser-profiles/*"]
    }
  }
  statement {
    sid    = "BrowserProfileReadWrite"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/browser-profiles/*"]
  }
}

resource "aws_iam_policy" "bake_rw" {
  name        = "${var.name_prefix}-artifacts-bake-rw"
  description = "Read-write access to Gantry capability artifacts (bake role only)."
  policy      = data.aws_iam_policy_document.bake_rw.json
  tags        = var.tags
}

resource "aws_iam_policy" "worker_ro" {
  name        = "${var.name_prefix}-artifacts-worker-ro"
  description = "Read-only access to Gantry capability artifacts (worker role)."
  policy      = data.aws_iam_policy_document.worker_ro.json
  tags        = var.tags
}

resource "aws_iam_policy" "worker_browser_rw" {
  name        = "${var.name_prefix}-browser-profiles-worker-rw"
  description = "Read-write access to worker-authored browser profile snapshots."
  policy      = data.aws_iam_policy_document.worker_browser_rw.json
  tags        = var.tags
}
