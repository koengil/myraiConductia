# The wake function: every minute it refreshes the runner registration token in
# SSM when older than 45 minutes, counts queued jobs that want a conductia-ci-*
# label and starts stopped runner instances to match (lambda/wake.mjs). Runners stop themselves when idle (templates/idle-stop.sh).

# The function and its pure planning module; plan.test.mjs stays out of the zip.
data "archive_file" "wake" {
  type        = "zip"
  output_path = "${path.module}/.build/wake.zip"

  source {
    content  = file("${path.module}/lambda/wake.mjs")
    filename = "wake.mjs"
  }
  source {
    content  = file("${path.module}/lambda/plan.mjs")
    filename = "plan.mjs"
  }
}

resource "aws_lambda_function" "wake" {
  function_name    = local.wake_name
  description      = "Start stopped CI runners when GitHub has queued jobs for them"
  role             = aws_iam_role.wake.arn
  runtime          = "nodejs22.x"
  handler          = "wake.handler"
  filename         = data.archive_file.wake.output_path
  source_code_hash = data.archive_file.wake.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      REPO          = var.github_repo
      SSM_PARAM     = local.pat_parameter
      TOKEN_PARAM   = local.token_parameter
      TAG_KEY       = "Component"
      TAG_VALUE     = "ci-runner"
      LABEL_PREFIX  = "conductia-ci-"
      HEAVY_LABEL   = "conductia-ci-heavy"
      HEAVY_CLASSES = join(",", [for k, c in var.runner_classes : k if contains(c.labels, "conductia-ci-heavy")])
      BURST_CLASSES = join(",", [for k, c in var.runner_classes : k if startswith(k, "burst")])
    }
  }

  depends_on = [aws_cloudwatch_log_group.wake, aws_iam_role_policy.wake]
}

resource "aws_scheduler_schedule" "wake" {
  name                         = local.wake_name
  group_name                   = "default"
  schedule_expression          = "rate(1 minute)"
  schedule_expression_timezone = "UTC"
  state                        = var.wake_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.wake.arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_event_age_in_seconds = 60
      maximum_retry_attempts       = 0
    }
  }
}
