# ---------------------------------------------------------------------------
# Terraform remote-state backend.
#
# Run this once, before the root module, then uncomment infra/backend.tf and run
# `terraform init -migrate-state` there.
#
#     cd infra/bootstrap
#     terraform init
#     terraform apply
#
# It creates exactly two things and nothing else:
#
#   * A versioned, encrypted, fully private S3 bucket for state.
#   * A DynamoDB table for state locks.
#
# Kept separate from the root module because a backend cannot host the state of the
# configuration that creates it. Its own state stays local and is safe to commit — see
# the note in versions.tf.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  # Account id in the name as well as the random suffix: it makes the bucket obviously
  # attributable at a glance in a shared organisation, and removes any chance of two
  # accounts in the same org racing for one name.
  bucket_name = coalesce(
    var.state_bucket_name,
    "${var.project}-tfstate-${data.aws_caller_identity.current.account_id}-${random_id.suffix.hex}",
  )

  table_name = coalesce(var.lock_table_name, "${var.project}-tfstate-locks")
}

# ---------------------------------------------------------------------------
# State bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = local.bucket_name

  # State is the map of everything that exists. Losing it does not destroy the
  # infrastructure, but it does mean Terraform no longer knows about it, and rebuilding
  # that association by hand is days of work. Deleting this bucket should require
  # deliberately editing this file first.
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = local.bucket_name }
}

# Versioning is the only realistic recovery from state corruption or truncation, and it
# has to be enabled before the damage, not after.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      # SSE-S3 rather than a CMK on purpose: a customer-managed key would have to be
      # created by this same module, and a key policy mistake would then lock Terraform
      # out of its own state with no way back in. AES-256 at rest is the requirement;
      # key custody is not.
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  # Versioning without expiry accumulates every state file ever written, forever. This
  # keeps a long recovery window and then stops.
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyUnencryptedObjectUploads"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/*"]

    # Denies a PUT that explicitly asks for no encryption. A PUT with no
    # x-amz-server-side-encryption header at all is still accepted and picks up the
    # bucket default above, which is what the Terraform S3 backend actually sends.
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["AES256", "aws:kms"]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}

# ---------------------------------------------------------------------------
# Lock table
# ---------------------------------------------------------------------------
# This is what stops two applies running at once — a colleague and CI, or two terminals.
# Concurrent applies against shared state corrupt it silently and expensively.

resource "aws_dynamodb_table" "locks" {
  name = local.table_name

  # PAY_PER_REQUEST because the access pattern is a handful of writes per apply. Provisioned
  # capacity would cost more while idle and still throttle a burst.
  billing_mode = "PAY_PER_REQUEST"

  # The attribute name is fixed by the Terraform S3 backend; it is not a free choice.
  hash_key = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = local.table_name }
}
