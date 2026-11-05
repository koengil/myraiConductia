# The deploy runner group (#639, ADR-0028): a launcher Lambda that mints one
# just-in-time runner in the org group conductia-deploy for each admitted deploy
# job, on a fresh VM that serves that job and terminates.
#
# Applied only by an admin principal (var.launcher_admin_arns), never by the CI
# operator that applies infra/ci-runner: the operator must not be able to change
# the launcher (design R11, R21). Runbook: ADR-0028. CI and developer machines
# only run the offline checks (scripts/infra/validate.sh).

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

  # Its own key in the CI state bucket (infra/ci-runner/bootstrap). Given at init:
  #   tofu init -backend-config=bucket=<bucket> -backend-config=region=<region> \
  #     -backend-config=kms_key_id=<state key ARN>
  backend "s3" {
    key          = "deploy-runner/terraform.tfstate"
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
