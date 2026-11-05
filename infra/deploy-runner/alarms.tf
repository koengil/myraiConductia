# The deploy runner's alert path (design R17, R25; ADR-0028): the launcher's JSON
# log records feed metric filters, their alarms notify one SNS topic, and the
# owner subscribes an email to it (O10). Every later alarm and audit rule of this
# module (the unknown-runner check, the launcher Errors alarm, the R22 rules)
# notifies the same topic, so this file owns the topic and its whole policy.
#
# What alarms here:
#   - DeployTripwire: any deploy_tripwire record. A queued job that could take a
#     deploy runner and was refused (not_allowlisted, expired, provenance,
#     foreign_repo), a deploy runner that took a job of a refused run
#     (served_refused), or a runner group that is not exactly what it must be
#     (group_misconfigured). A cold-start self-check that finds RunInstances
#     denied joins it (round 2 #7): the launcher could mint and never launch.
#   - DeployHeldWithAdmittedWaiting: minting held for 10 minutes in a row while
#     admitted jobs wait (round 2 #5). The tripwire alarm emails once per OK to
#     ALARM transition, so a renewed freeze on a release day would otherwise stay
#     silent after the first email.
#   - DeployUnknownRunner: a runner in the deploy group that no trusted deploy VM
#     carries (design R23). Only the App key or an org owner can register into
#     the group, so it means the key leaked or someone added a runner by hand.
#     Its own alarm, so the email says which kind of trip it is.
#   - DeployLauncherErrors: the launcher function itself failing (AWS/Lambda
#     Errors), tick after tick (outline Phase 6, thread O19). A broken launcher
#     mints nothing and logs no tripwire, so without it the Oct 26 dry run would
#     stall without a sound.
#
# The records hold ids and codes only; the alert names the alarm, and the log
# group keeps every id. The topic is not KMS-encrypted on purpose: the bodies
# hold no content, and a tamperer who disabled a key must not be able to silence
# the alert that reports it (infra/discovery-worker/alerts.tf).

locals {
  metric_namespace = "Conductia/DeployRunner"

  # The three filter-fed alarms read Maximum, not Sum (audit V13): a negative
  # datapoint put into their metric from elsewhere could cancel a Sum, never a
  # Maximum. Each filter emits 1 per matching record.

  # Lambda's JSON log format keeps a record logged as one object argument as an
  # object under "message" (review 1, #7).
  tripwire_pattern = "{ ($.message.event = \"deploy_tripwire\") || ($.message.event = \"deploy_blind\") || (($.message.event = \"deploy_selfcheck\") && ($.message.run_instances = \"denied\")) }"
  hold_pattern     = "{ ($.message.event = \"deploy_hold\") && ($.message.admitted_waiting > 0) }"
  unknown_pattern  = "{ $.message.event = \"deploy_unknown_runner\" }"
}

# Topic --------------------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

# A copy of infra/discovery-worker/alerts.tf (review 1, #8): the account's own
# IAM policies keep the default topic actions, and EventBridge (the R22 rules,
# PR C) and CloudWatch alarms (this file) may publish, from this account only.
# An events-only policy would silence every alarm.
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountIamPolicies"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
        # The AWS default topic statement's actions; SNS rejects "sns:*" in a topic policy.
        Action = [
          "sns:GetTopicAttributes",
          "sns:SetTopicAttributes",
          "sns:AddPermission",
          "sns:RemovePermission",
          "sns:DeleteTopic",
          "sns:Subscribe",
          "sns:ListSubscriptionsByTopic",
          "sns:Publish",
        ]
        Resource = aws_sns_topic.alerts.arn
      },
      {
        Sid       = "EventBridgeAndAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = ["events.amazonaws.com", "cloudwatch.amazonaws.com"] }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id } }
      },
    ]
  })
}

# Tripwire (R17) -------------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "tripwire" {
  name           = "${local.name}-tripwire"
  log_group_name = aws_cloudwatch_log_group.launcher.name
  pattern        = local.tripwire_pattern

  metric_transformation {
    name      = "DeployTripwire"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "tripwire" {
  alarm_name          = "${local.name}-tripwire"
  alarm_description   = "A deploy_tripwire or deploy_blind record in the launcher's log (ADR-0028 runbook: tripwire). Read the record's reason and ids, or scope and error, in /aws/lambda/${local.launcher_name}."
  namespace           = local.metric_namespace
  metric_name         = "DeployTripwire"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# The hold (R25, round 2 #5) -------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "hold" {
  name           = "${local.name}-held-with-admitted-waiting"
  log_group_name = aws_cloudwatch_log_group.launcher.name
  pattern        = local.hold_pattern

  metric_transformation {
    name      = "DeployHeldWithAdmittedWaiting"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "hold" {
  alarm_name          = "${local.name}-held-with-admitted-waiting"
  alarm_description   = "Minting held for 10 minutes while admitted deploy jobs wait (ADR-0028 runbook: hold). Cancel the refused run named by the tripwire records."
  namespace           = local.metric_namespace
  metric_name         = "DeployHeldWithAdmittedWaiting"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 10
  datapoints_to_alarm = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Unknown runner (R23) -------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "unknown_runner" {
  name           = "${local.name}-unknown-runner"
  log_group_name = aws_cloudwatch_log_group.launcher.name
  pattern        = local.unknown_pattern

  metric_transformation {
    name      = "DeployUnknownRunner"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "unknown_runner" {
  alarm_name          = "${local.name}-unknown-runner"
  alarm_description   = "A runner in the deploy group that the launcher did not mint (ADR-0028 runbook: unknown runner). Delete it, revoke and rotate the App key, review the audit events."
  namespace           = local.metric_namespace
  metric_name         = "DeployUnknownRunner"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Launcher errors (outline Phase 6, O19) ------------------------------------------------------

# The tick throws, and the invocation counts in AWS/Lambda Errors, when the
# configuration, the App key, the installation token, the group, its runners,
# the EC2 describe or a generate-jitconfig call fails (lambda/deploy.mjs,
# handler). A timeout counts too. A failed DELETE, RunInstances or terminate
# does not throw: it lands in the deploy_tick record's error field and the tick
# goes on. Nor does a failed run or job read: it is a deploy_blind record, which
# the tripwire alarm counts (audit V1).
#
# Thresholds, for a one-minute schedule (one invocation a minute; neither
# Scheduler nor Lambda retries a failed one, launcher.tf):
#   - period 60: Lambda publishes Errors per minute, so one datapoint is one tick.
#   - 3 of 5 periods: one failed tick (a GitHub 5xx, a slow API hitting the 50 s
#     timeout) is retried by the next tick a minute later and pages nobody.
#     Three failed ticks in five minutes is a broken launcher. It fires after the
#     third consecutive failure, inside the post-hoc check's 5-minute window
#     (design R25, which assumes the launcher ran in the last 5 minutes), and
#     still fires when ticks fail every other minute.
#   - notBreaching: no invocation means no datapoint. The module ships with the
#     schedule disabled (launcher_enabled = false), and a dormant launcher is not
#     an error. A schedule that stops is not this alarm's job: the guard denies
#     changing it, and the audit rule launcher-changed (PR C) reports it.
#   - ok_actions: the named canceller (O21) learns from the same inbox when the
#     launcher recovers, without polling the log on a release day.
resource "aws_cloudwatch_metric_alarm" "launcher_errors" {
  alarm_name          = "${local.name}-launcher-errors"
  alarm_description   = "The launcher ${local.launcher_name} failed 3 of its last 5 one-minute ticks: nothing is minted or reaped while it fails (ADR-0028 runbook: launcher errors). Read the deploy_tick error names in /aws/lambda/${local.launcher_name}."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    FunctionName = aws_lambda_function.launcher.function_name
  }
}
