# Names shared across the module. Every name and IAM path fits the operator
# policy's scope: IAM under /ci-runner/, Lambda and Scheduler names starting
# conductia-ci-runner, log groups /conductia/ci-runner* and
# /aws/lambda/conductia-ci-runner*, SSM parameters under /conductia/ci-runner/.

locals {
  name      = "conductia-ci-runner"
  iam_path  = "/ci-runner/"
  log_group = "/conductia/ci-runner"
  wake_name = "conductia-ci-runner-wake"

  allowed_account_ids = [var.aws_account_id]

  # Neither parameter is managed here. The PAT is created by hand (README) and
  # only the wake function reads it. The wake function writes a fresh runner
  # registration token, the only thing a runner host may read.
  pat_parameter       = "/conductia/ci-runner/github-pat"
  token_parameter     = "/conductia/ci-runner/registration-token"
  pat_parameter_arn   = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${local.pat_parameter}"
  token_parameter_arn = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${local.token_parameter}"

  # One entry per runner: heavy-1, heavy-2, light-1, ...
  runners = merge([
    for class, c in var.runner_classes : {
      for i in range(c.count) : "${class}-${i + 1}" => merge(c, { class = class })
    }
  ]...)

  tags = {
    Project   = "conductia"
    Component = "ci-runner"
    ManagedBy = "opentofu"
    Ticket    = "ADR-0027"
  }
}
