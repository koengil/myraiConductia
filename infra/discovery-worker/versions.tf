# The discovery worker in Ignatious's dedicated AWS account (#344).
# Runbook: docs/04-operations/discovery-worker-aws-runbook.md. Applied by the
# owner in the runbook's order; nothing in CI or on a developer machine ever
# plans or applies it against an account (scripts/infra/validate.sh is offline).

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  # State lives in the bucket bootstrap/ creates (design R2). The bucket, its
  # region and its KMS key are account-specific and are given at init:
  #   tofu init -backend-config=bucket=<bucket> -backend-config=region=<region> \
  #     -backend-config=kms_key_id=<state key ARN>
  # use_lockfile is OpenTofu's native S3 lock: no DynamoDB table.
  backend "s3" {
    key          = "discovery-worker/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}

# Global-service events (IAM, STS global, root sign-in) reach EventBridge in
# us-east-1 only, so their alert rules use this alias (design R10, alerts.tf).
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}
