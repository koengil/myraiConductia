# Read-only audit role that Vanta's scanner assumes for SOC 2 tests (#467).
# Runbook: README.md in this directory. Applied by the owner; CI and developer
# machines only run the offline checks (scripts/infra/validate.sh).

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  # State lives in a bucket made by hand (README). Given at init:
  #   tofu init -backend-config=bucket=<bucket> -backend-config=region=<region>
  backend "s3" {
    key          = "vanta/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]
}
