# Offline plan test for the state bucket and key (mock AWS provider).

mock_provider "aws" {
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::conductia-ci-runner-tfstate-123456789012"
    }
  }
}

variables {
  aws_account_id = "123456789012"
}

run "state_bucket_and_key" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "conductia-ci-runner-tfstate-123456789012" && aws_kms_alias.state.name == "alias/conductia-ci-runner-tfstate"
    error_message = "Bucket and alias names fit the ci-runner scope."
  }
  assert {
    condition     = aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced" && aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "Versioned, BucketOwnerEnforced."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.state.restrict_public_buckets && aws_s3_bucket_public_access_block.state.block_public_policy
    error_message = "Public access is blocked."
  }
}
