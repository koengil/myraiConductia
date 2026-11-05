# Egress and runtime detection (design R11). The security group allows tcp 443
# and 5432 to any address (network.tf); this file is what would show a
# compromised task using that:
#   - VPC flow logs, every accepted and rejected flow, to a KMS log group;
#   - Route 53 Resolver query logging, every lookup from the VPC, to a KMS log
#     group, with an alarm on DNS Firewall hits (alarms.tf);
#   - a Resolver DNS Firewall that ALLOWs the allowlist and applies
#     dns_firewall_action to every other name: ALERT (logged, answered) until
#     the probe is green, then BLOCK (NXDOMAIN) from runbook step 10. G8
#     requires BLOCK;
#   - GuardDuty with ECS Fargate runtime monitoring and automated agent
#     management; findings page the owner and the CCO (alerts.tf).
#
# The recorded residual G0 signs: DNS Firewall sees names, not connections. A
# connection to an IP literal on 443 or 5432 is not blocked; the flow logs and
# GuardDuty are what would show it.

locals {
  flow_log_group_name      = "/conductia/discovery-worker/vpc-flow-logs"
  dns_query_log_group_name = "/conductia/discovery-worker/resolver-queries"

  supabase_host = trimprefix(var.supabase_url, "https://")

  # The names the worker and the Fargate platform resolve through the task's
  # network interface (design R11). Google: STS, IAM Credentials, OAuth, Gmail,
  # Admin Directory. Supabase: REST and the session pooler. AWS: the image and
  # its layers (the GuardDuty agent's included, by the same names), logs, the
  # secrets and parameters, and the GuardDuty agent's data endpoint.
  dns_allowlist_baseline = [
    "*.googleapis.com",
    local.supabase_host,
    "*.pooler.supabase.com",
    "api.ecr.${var.region}.amazonaws.com",
    "*.dkr.ecr.${var.region}.amazonaws.com",
    "prod-${var.region}-starport-layer-bucket.s3.${var.region}.amazonaws.com",
    "prod-${var.region}-starport-layer-bucket.s3.amazonaws.com",
    "logs.${var.region}.amazonaws.com",
    "secretsmanager.${var.region}.amazonaws.com",
    "ssm.${var.region}.amazonaws.com",
    "guardduty-data.${var.region}.amazonaws.com",
  ]
  dns_allowlist = distinct(concat(local.dns_allowlist_baseline, var.dns_allowlist))

  # GuardDuty's Fargate agent repositories, from "ECR Repository for GuardDuty
  # agent on AWS Fargate (Amazon ECS only)" in the GuardDuty user guide (checked
  # 2026-10-04). The repository is aws-guardduty-agent-fargate in each account.
  guardduty_agent_accounts = {
    "af-south-1"     = "197869348890"
    "ap-east-1"      = "258348409381"
    "ap-east-2"      = "259886477082"
    "ap-northeast-1" = "533107202818"
    "ap-northeast-2" = "914738172881"
    "ap-northeast-3" = "273192626886"
    "ap-south-1"     = "251508486986"
    "ap-south-2"     = "950823858135"
    "ap-southeast-1" = "174946120834"
    "ap-southeast-2" = "005257825471"
    "ap-southeast-3" = "510637619217"
    "ap-southeast-4" = "251357961535"
    "ap-southeast-5" = "156041399949"
    "ap-southeast-7" = "054037130133"
    "ca-central-1"   = "354763396469"
    "ca-west-1"      = "339712888787"
    "eu-central-1"   = "323658145986"
    "eu-central-2"   = "529164026651"
    "eu-north-1"     = "591436053604"
    "eu-south-1"     = "266869475730"
    "eu-south-2"     = "919611009337"
    "eu-west-1"      = "694911143906"
    "eu-west-2"      = "892757235363"
    "eu-west-3"      = "665651866788"
    "il-central-1"   = "870907303882"
    "me-central-1"   = "000014521398"
    "me-south-1"     = "536382113932"
    "mx-central-1"   = "311141559934"
    "sa-east-1"      = "758426053663"
    "us-east-1"      = "593207742271"
    "us-east-2"      = "307168627858"
    "us-west-1"      = "684579721401"
    "us-west-2"      = "733349766148"
  }
  # Null only for a region the table lacks and no variable names; the execution
  # role's precondition (iam.tf) then refuses the plan.
  guardduty_agent_repository_arn = (
    var.guardduty_agent_repository_arn != null ? var.guardduty_agent_repository_arn :
    contains(keys(local.guardduty_agent_accounts), var.region) ? "arn:aws:ecr:${var.region}:${local.guardduty_agent_accounts[var.region]}:repository/aws-guardduty-agent-fargate" :
    null
  )

  guardduty_detector_id = var.guardduty_detector_id != null ? var.guardduty_detector_id : aws_guardduty_detector.worker[0].id
}

# Flow logs ---------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "flow" {
  name              = local.flow_log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.worker.arn
}

resource "aws_iam_role" "flow_logs" {
  name        = "${local.name}-flow-logs"
  path        = "/"
  description = "VPC flow logs delivery into the worker VPC's flow log group"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "FlowLogsOfThisAccountOnly"
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ec2:${var.region}:${var.aws_account_id}:vpc-flow-log/*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "discovery-worker-flow-logs"
  role = aws_iam_role.flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteTheFlowLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
        Resource = [aws_cloudwatch_log_group.flow.arn, "${aws_cloudwatch_log_group.flow.arn}:*"]
      },
      {
        # The flow log group is under the worker key: through Logs only (iam.tf).
        Sid      = "WriteTheLogGroupThroughLogs"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource = [aws_kms_key.worker.arn]
        Condition = {
          StringEquals = { "kms:ViaService" = "logs.${var.region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_flow_log" "worker" {
  vpc_id                   = aws_vpc.worker.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flow_logs.arn
  max_aggregation_interval = 60

  tags = { Name = local.name }
}

# Resolver query logging ----------------------------------------------------------

resource "aws_cloudwatch_log_group" "dns" {
  name              = local.dns_query_log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.worker.arn
}

# Resolver query logs are vended logs, written by the log delivery service.
resource "aws_cloudwatch_log_resource_policy" "dns" {
  policy_name = "${local.name}-resolver-queries"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "ResolverQueryLogDelivery"
      Effect    = "Allow"
      Principal = { Service = "delivery.logs.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = "${aws_cloudwatch_log_group.dns.arn}:*"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:logs:${var.region}:${var.aws_account_id}:*" }
      }
    }]
  })
}

resource "aws_route53_resolver_query_log_config" "worker" {
  name            = local.name
  destination_arn = aws_cloudwatch_log_group.dns.arn

  depends_on = [aws_cloudwatch_log_resource_policy.dns]
}

resource "aws_route53_resolver_query_log_config_association" "worker" {
  resolver_query_log_config_id = aws_route53_resolver_query_log_config.worker.id
  resource_id                  = aws_vpc.worker.id
}

# DNS Firewall ----------------------------------------------------------------------

# AWS stores each domain fully qualified (trailing dot); writing them that way
# keeps the plan from rewriting both lists on every run.
resource "aws_route53_resolver_firewall_domain_list" "allowed" {
  name    = "${local.name}-allowed"
  domains = [for name in local.dns_allowlist : "${name}."]
}

resource "aws_route53_resolver_firewall_domain_list" "everything" {
  name    = "${local.name}-everything"
  domains = ["*."]
}

resource "aws_route53_resolver_firewall_rule_group" "worker" {
  name = local.name
}

resource "aws_route53_resolver_firewall_rule" "allowed" {
  name                    = "allow-the-allowlist"
  action                  = "ALLOW"
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.allowed.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.worker.id
  priority                = 100
}

resource "aws_route53_resolver_firewall_rule" "everything_else" {
  name                    = "everything-else"
  action                  = var.dns_firewall_action
  block_response          = var.dns_firewall_action == "BLOCK" ? "NXDOMAIN" : null
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.everything.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.worker.id
  priority                = 200
}

resource "aws_route53_resolver_firewall_rule_group_association" "worker" {
  name                   = local.name
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.worker.id
  vpc_id                 = aws_vpc.worker.id
  priority               = 101
}

# If DNS Firewall cannot evaluate a query, the query fails (fail closed).
resource "aws_route53_resolver_firewall_config" "worker" {
  resource_id        = aws_vpc.worker.id
  firewall_fail_open = "DISABLED"
}

# GuardDuty ---------------------------------------------------------------------------

# An account holds at most one detector per region: created here only when the
# owner reports none (O1). Otherwise the module adds the feature to theirs.
resource "aws_guardduty_detector" "worker" {
  count = var.guardduty_detector_id == null ? 1 : 0

  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

# Fargate runtime monitoring with automated agent management: GuardDuty adds its
# agent as a sidecar to every new task, pulled with the execution role from
# GuardDuty's own repository (iam.tf), and creates its data endpoint in the VPC.
resource "aws_guardduty_detector_feature" "runtime_monitoring" {
  detector_id = local.guardduty_detector_id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"

  additional_configuration {
    name   = "ECS_FARGATE_AGENT_MANAGEMENT"
    status = "ENABLED"
  }
}
