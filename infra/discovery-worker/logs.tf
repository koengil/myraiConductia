# The worker's log group (design R12): ids, codes and counts only, one JSON line
# per job and tick. KMS-encrypted, 365 days by default.

resource "aws_cloudwatch_log_group" "worker" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.worker.arn
}
