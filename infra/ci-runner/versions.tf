# Self-hosted GitHub Actions runners for Conductia/Conductia (ADR-0027 trial).
# Runbook: README.md in this directory. Applied by the owner; CI and developer
# machines only run the offline checks (scripts/infra/validate.sh).

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # State lives in the bucket bootstrap/ creates. Given at init:
  #   tofu init -backend-config=bucket=<bucket> -backend-config=region=<region> \
  #     -backend-config=kms_key_id=<state key ARN>
  backend "s3" {
    key          = "ci-runner/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = local.tags
  }
}
