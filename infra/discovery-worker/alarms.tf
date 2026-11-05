# Operational and leak alarms (design R11, R12, R14; A14). All notify the alert
# topic, so the owner and the CCO both receive them. Alarm bodies carry the
# alarm name, state and metric, never log text.
#
# The filters read the worker's own JSON lines (worker/jobLog.ts, Phase 3):
#   {"evt":"tick","queued":n}                                a tick that ran
#   {"evt":"tick","status":"failed","reason":<code>}         a tick that failed
#   {"evt":"sync",...,"status":"failed","reason":<code>}     a sync job that failed
#   {"evt":"orphan_collection_failed"}, {"evt":"group_removal_failed"}  a failed tick deletion step (#461)
#   {"evt":"accept_expiry_failed"}                          a failed accept expiry, which purges stale accept text (G-02b #173)
#   {"evt":"group_removal_held","tenant":<id>,"due":n}       a breaker hold, a notice (#461)
#   {"evt":"group_removal_overdue","tenant":<id>,"due":n}    a hold unreleased 24h after it fell due
# tests/infra/discovery-worker-contract.test.ts pins these evt names and the
# failed status on both sides, so a renamed event fails CI instead of silently
# disarming an alarm.
#
# The tick and running-task alarms exist only while the worker is meant to run
# (classify_desired_count > 0): at zero, a stopped worker is the intended state.
# Both treat missing data as breaching, so a worker that prints nothing alarms.
# The extract running-task alarm is gated like the extract service (ecs.tf):
# it exists only in stage 2 with extract_desired_count > 0 (#474).

locals {
  metric_namespace = "Conductia/DiscoveryWorker"
  worker_running   = var.classify_desired_count > 0

  # An address in a worker log line means a code path leaked (design R12). The
  # regex uses only what CloudWatch filter patterns accept (alphanumerics, the
  # symbols : _ # = @ / ; , - and the operators ^ $ ? [ ] { } | \ * + .; no
  # parentheses), per the CloudWatch Logs filter pattern syntax, checked
  # 2026-10-04.
  address_pattern = "%[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\\.[A-Za-z]+%"
}

# Ticks -------------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "ticks" {
  name           = "conductia-discovery-ticks"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ ($.evt = \"tick\") && ($.status NOT EXISTS) }"

  metric_transformation {
    name      = "Ticks"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "ticks" {
  count = local.worker_running ? 1 : 0

  alarm_name          = "conductia-discovery-no-tick"
  alarm_description   = "No discovery worker tick in 15 minutes (the cron runs every 5): the consumer is down, crash-looping or silent."
  namespace           = local.metric_namespace
  metric_name         = "Ticks"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Running task count (Container Insights) -------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  count = local.worker_running ? 1 : 0

  alarm_name          = "conductia-discovery-no-running-task"
  alarm_description   = "The classify service has had no running task for 10 minutes."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    ClusterName = local.cluster_name
    ServiceName = local.services.classify
  }
}

# The extract service runs only under P2 = B. A ZDR stop exits 1 and ECS
# restarts the task, so a crash loop can also read as no running task (#474).
resource "aws_cloudwatch_metric_alarm" "extract_running_tasks" {
  count = local.stage2 && var.extract_desired_count > 0 ? 1 : 0

  alarm_name          = "conductia-discovery-extract-no-running-task"
  alarm_description   = "The extract service has had no running task for 10 minutes: it is down or restarting."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    ClusterName = local.cluster_name
    ServiceName = local.services.extract
  }
}

# Sync failures ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "sync_failures" {
  name           = "conductia-discovery-sync-failures"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ ($.evt = \"sync\") && ($.status = \"failed\") }"

  metric_transformation {
    name      = "SyncFailures"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "sync_failures" {
  alarm_name          = "conductia-discovery-sync-failures"
  alarm_description   = "Five or more failed sync jobs in 30 minutes. The codes are in the sync lines and the admin's Ingestion health panel."
  namespace           = local.metric_namespace
  metric_name         = "SyncFailures"
  statistic           = "Sum"
  period              = 1800
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Deletion steps (#461) -----------------------------------------------------------------------
# The backstop, the group-removal withdrawal and the accept expiry (G-02b #173: it
# purges the text of accept requests a crash left behind) are best effort, so a failure is
# only a line. Three in 30 minutes (six ticks), or a breaker hold left
# unreleased 24 hours after it fell due, means consent-ended mail is not being
# deleted. A hold inside those 24 hours is the expected pilot state (D93): it
# raises the lower-severity held notice below, never this alarm.

resource "aws_cloudwatch_log_metric_filter" "deletion_steps" {
  name           = "conductia-discovery-deletion-steps"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ ($.evt = \"orphan_collection_failed\") || ($.evt = \"group_removal_failed\") || ($.evt = \"group_removal_overdue\") || ($.evt = \"accept_expiry_failed\") }"

  metric_transformation {
    name      = "DeletionStepProblems"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "deletion_steps" {
  alarm_name          = "conductia-discovery-deletion-stuck"
  alarm_description   = "A tick's deletion step failed, or a group-removal hold is 24 hours overdue, three times in 30 minutes: mail may not be deleted. See the runbook, The backstop."
  namespace           = local.metric_namespace
  metric_name         = "DeletionStepProblems"
  statistic           = "Sum"
  period              = 1800
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# A breaker hold (D93): expected, actionable, not a failure. The line names the
# tenant id and the due count; the metric counts the lines. A notice, one email
# when holds appear, no OK message: the operator checks the group and releases
# within 24 hours, after which the hold is overdue and counts as stuck above.

resource "aws_cloudwatch_log_metric_filter" "group_removal_held" {
  name           = "conductia-discovery-group-removal-held"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.evt = \"group_removal_held\" }"

  metric_transformation {
    name      = "GroupRemovalHeld"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "group_removal_held" {
  alarm_name          = "conductia-discovery-group-removal-held"
  alarm_description   = "Notice, not a failure: the group-removal breaker holds a withdrawal for the operator. The worker line names the tenant id and the count. Check the group and release within 24 hours. See the runbook, Group removal."
  namespace           = local.metric_namespace
  metric_name         = "GroupRemovalHeld"
  statistic           = "Sum"
  period              = 1800
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Address-shaped text in the worker's logs ------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "address_in_logs" {
  name           = "conductia-discovery-address-in-logs"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = local.address_pattern

  metric_transformation {
    name      = "AddressShapedLines"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "address_in_logs" {
  alarm_name          = "conductia-discovery-address-in-logs"
  alarm_description   = "An address-shaped string reached the worker's log group: a code path leaked. Find the line by its time, never by searching for the address."
  namespace           = local.metric_namespace
  metric_name         = "AddressShapedLines"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# DNS Firewall hits ---------------------------------------------------------------------------------

# Resolver fills firewall_rule_action only for an ALERT or BLOCK match.
resource "aws_cloudwatch_log_metric_filter" "dns_firewall_hits" {
  name           = "conductia-discovery-dns-firewall-hits"
  log_group_name = aws_cloudwatch_log_group.dns.name
  pattern        = "{ ($.firewall_rule_action = \"ALERT\") || ($.firewall_rule_action = \"BLOCK\") }"

  metric_transformation {
    name      = "DnsFirewallHits"
    namespace = local.metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "dns_firewall_hits" {
  alarm_name          = "conductia-discovery-dns-firewall-hits"
  alarm_description   = "A lookup from the worker VPC matched no allowlisted name (ALERT or BLOCK). Review the query log for the name."
  namespace           = local.metric_namespace
  metric_name         = "DnsFirewallHits"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
