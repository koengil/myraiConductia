# The worker image's repository, created in stage 1 so the image can be pushed
# before any task definition names it (design R3, R20). Tags are immutable: a
# rebuild of the same commit takes the next <sha>-<n>, and the task definitions
# pin the digest, never a tag.

resource "aws_ecr_repository" "worker" {
  name                 = local.ecr_repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.worker.arn
  }
}
