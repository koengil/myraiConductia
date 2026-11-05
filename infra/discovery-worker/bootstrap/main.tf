# The state bucket for infra/discovery-worker (design R2; runbook step 1). Run
# once, as admin, with local state: keep this directory's terraform.tfstate with
# the owner's account records (it describes the bucket and its key, nothing
# secret). The main module then stores its state here, locked with OpenTofu's
# native S3 lockfile.

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
}

variable "aws_account_id" {
  description = "Ignatious's dedicated AWS account (12 digits)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be the 12-digit account id."
  }
}

variable "region" {
  description = "The region for the state bucket; the same as the worker's."
  type        = string
  default     = "us-east-1"
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project   = "conductia"
      Component = "discovery-worker-state"
      ManagedBy = "opentofu"
      Ticket    = "344"
    }
  }
}

resource "aws_kms_key" "state" {
  description             = "Conductia discovery worker: OpenTofu state"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "state" {
  name          = "alias/conductia-discovery-worker-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  bucket = "conductia-discovery-worker-tfstate-${var.aws_account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

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
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
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

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "state_bucket" {
  description = "The main module's -backend-config=bucket value."
  value       = aws_s3_bucket.state.bucket
}

output "state_kms_key_arn" {
  description = "The main module's -backend-config=kms_key_id value."
  value       = aws_kms_key.state.arn
}

output "region" {
  description = "The main module's -backend-config=region value."
  value       = var.region
}
