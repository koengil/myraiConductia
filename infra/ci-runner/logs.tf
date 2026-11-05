# Runner hosts ship cloud-init output, the runner's _diag logs and the job-hook
# log here (one stream per instance and file). The wake function logs counts only.

resource "aws_cloudwatch_log_group" "runner" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "wake" {
  name              = "/aws/lambda/${local.wake_name}"
  retention_in_days = var.log_retention_days
}
