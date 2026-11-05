# A4 and A16 alerts (design R8, R10): EventBridge rules on the trail's events and
# on GuardDuty findings, to an SNS topic that emails the owner and Ignatious's
# CCO. Both subscriptions are confirmed before G8, and G8 proves delivery to both.
#
# What pages:
#   - every use of the operations deploy holds (RunTask, StopTask,
#     UpdateService), any RegisterTaskDefinition, a RunTask or StartTask carrying
#     overrides on its own rule (a container command, a task role, the execution
#     role named as the task role included), any assumption of deploy, and any
#     assumption of the task role not made by ECS;
#   - a secret read by anyone but the execution role, any secret change, and
#     any write or delete of the probe's two SSM parameters;
#   - GuardDuty findings of severity 4 or more;
#   - tampering with the detection itself: the alert topics, the trail and its
#     bucket, GuardDuty, the DNS Firewall and query logging, the flow logs, the
#     worker security group, the keys, their aliases and grants, these rules and
#     the alarms and log groups. The topic, rule and log-group rules exist in
#     us-east-1 too when the region is elsewhere, since the global rules and
#     their topic live there. The Put and Update rules also
#     fire on every legitimate apply: the runbook announces each apply window
#     to the CCO, and an alert outside a window is the signal.
#   - IAM changes to the module's roles, a new access key and a root console
#     sign-in. Those are global-service events, which reach EventBridge in
#     us-east-1 only, so their rules use the us_east_1 alias, with their own
#     topic there when the region is not us-east-1.
#
# Alert bodies carry event names and ids only. Each target's input transformer
# picks named fields; none forwards requestParameters, responseElements or a
# finding's resource or service blocks, which can hold a command override, an
# address, an IP or a secret version. The full record stays in CloudTrail and
# GuardDuty.
#
# The topics are not KMS-encrypted on purpose: the bodies hold no content, and a
# tamperer who disabled a key must not be able to silence the alert that
# reports it (DisableKey pages through these topics).

locals {
  api_call = "AWS API Call via CloudTrail"

  task_role_arn        = "arn:aws:iam::${var.aws_account_id}:role/${var.task_role_name}"
  deploy_role_arn      = "arn:aws:iam::${var.aws_account_id}:role/${local.deploy_role_name}"
  execution_session    = "arn:aws:sts::${var.aws_account_id}:assumed-role/${local.name}-exec/"
  module_role_names    = [var.task_role_name, "${local.name}-exec", local.deploy_role_name, "${local.name}-flow-logs"]
  module_key_arns      = [aws_kms_key.worker.arn, aws_kms_key.trail.arn]
  module_alias_names   = ["alias/${local.name}", "alias/${local.name}-trail"]
  global_in_main_topic = var.region == "us-east-1"

  # Role assumptions are paged in the region (the CLI and ECS use regional STS)
  # and, when the region is not us-east-1, also there (the global endpoint).
  sts_rules = {
    "task-role-assumed-outside-ecs" = {
      kind                  = "cloudtrail"
      all_management_events = true
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource       = ["sts.amazonaws.com"]
          eventName         = ["AssumeRole"]
          requestParameters = { roleArn = [local.task_role_arn] }
          "$or" = [
            { userIdentity = { invokedBy = [{ exists = false }] } },
            { userIdentity = { invokedBy = [{ "anything-but" = ["ecs-tasks.amazonaws.com"] }] } },
          ]
        }
      }
    }
    "deploy-role-assumed" = {
      kind                  = "cloudtrail"
      all_management_events = true
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource       = ["sts.amazonaws.com"]
          eventName         = ["AssumeRole"]
          requestParameters = { roleArn = [local.deploy_role_arn] }
        }
      }
    }
  }

  # The alert path itself: its topics, its rules, the alarms and log groups.
  # Regional, and in us-east-1 too when the region is elsewhere (global rules).
  alert_path_tamper_rules = {
    "tamper-sns" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["sns.amazonaws.com"]
          eventName   = ["Unsubscribe", "SetSubscriptionAttributes", "SetTopicAttributes", "DeleteTopic", "RemovePermission"]
        }
      }
    }
    "tamper-eventbridge" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["events.amazonaws.com"]
          eventName   = ["DeleteRule", "DisableRule", "PutRule", "RemoveTargets", "PutTargets"]
        }
      }
    }
    "tamper-cloudwatch" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["monitoring.amazonaws.com", "logs.amazonaws.com"]
          eventName = [
            "DeleteAlarms", "DisableAlarmActions", "PutMetricAlarm",
            "DeleteMetricFilter", "PutMetricFilter",
            "PutRetentionPolicy", "DeleteRetentionPolicy", "DeleteLogGroup", "DisassociateKmsKey",
          ]
        }
      }
    }
  }

  regional_alert_rules = merge(local.sts_rules, local.alert_path_tamper_rules, {
    "ecs-operation" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["ecs.amazonaws.com"]
          eventName   = ["RegisterTaskDefinition", "RunTask", "StartTask", "StopTask", "UpdateService", "CreateService", "DeleteService", "ExecuteCommand"]
        }
      }
    }
    # Matches on the request, but forwards none of it (the transformer below).
    "ecs-task-overrides" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["ecs.amazonaws.com"]
          eventName   = ["RunTask", "StartTask"]
          "$or" = [
            { requestParameters = { overrides = { containerOverrides = { name = [{ exists = true }] } } } },
            { requestParameters = { overrides = { taskRoleArn = [{ exists = true }] } } },
            { requestParameters = { overrides = { executionRoleArn = [{ exists = true }] } } },
          ]
        }
      }
    }
    # A read-only event: only a rule in the all-management-events state sees it.
    "secret-read-outside-ecs" = {
      kind                  = "cloudtrail"
      all_management_events = true
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["secretsmanager.amazonaws.com"]
          eventName   = ["GetSecretValue", "BatchGetSecretValue"]
          "$or" = [
            { userIdentity = { arn = [{ exists = false }] } },
            { userIdentity = { arn = [{ "anything-but" = { prefix = local.execution_session } }] } },
          ]
        }
      }
    }
    "secret-changed" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["secretsmanager.amazonaws.com"]
          eventName   = ["PutSecretValue", "UpdateSecret", "DeleteSecret", "PutResourcePolicy"]
        }
      }
    }
    # The probe's test addresses: any write, label or delete under their prefix.
    "probe-parameter-changed" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["ssm.amazonaws.com"]
          eventName   = ["PutParameter", "DeleteParameter", "DeleteParameters", "LabelParameterVersion", "UnlabelParameterVersion"]
          "$or" = [
            { requestParameters = { name = [{ prefix = "${local.probe_parameter_prefix}/" }] } },
            { requestParameters = { names = [{ prefix = "${local.probe_parameter_prefix}/" }] } },
          ]
        }
      }
    }
    "guardduty-finding" = {
      kind                  = "guardduty"
      all_management_events = false
      pattern = {
        source        = ["aws.guardduty"]
        "detail-type" = ["GuardDuty Finding"]
        detail        = { severity = [{ numeric = [">=", 4] }] }
      }
    }
    "tamper-cloudtrail" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["cloudtrail.amazonaws.com"]
          eventName   = ["StopLogging", "UpdateTrail", "PutEventSelectors", "PutInsightSelectors", "DeleteTrail"]
        }
      }
    }
    # The trail's bucket: its policy, versioning, encryption, public-access block,
    # lifecycle and Object Lock (bucket-level calls are management events).
    "tamper-trail-bucket" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["s3.amazonaws.com"]
          eventName = [
            "PutBucketPolicy", "DeleteBucketPolicy", "PutBucketVersioning", "PutBucketEncryption", "DeleteBucketEncryption",
            "PutBucketPublicAccessBlock", "DeleteBucketPublicAccessBlock", "PutBucketLifecycle", "DeleteBucketLifecycle",
            "PutBucketObjectLockConfiguration", "PutBucketOwnershipControls", "PutBucketAcl", "DeleteBucket",
          ]
          requestParameters = { bucketName = [local.trail_bucket_name] }
        }
      }
    }
    # Any change to the worker's security group rules, or the group itself.
    "tamper-security-group" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["ec2.amazonaws.com"]
          eventName = [
            "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupIngress", "RevokeSecurityGroupEgress",
            "ModifySecurityGroupRules", "DeleteSecurityGroup",
          ]
          "$or" = [
            { requestParameters = { groupId = [aws_security_group.worker.id] } },
            { requestParameters = { ModifySecurityGroupRulesRequest = { GroupId = [aws_security_group.worker.id] } } },
          ]
        }
      }
    }
    # Feature changes (runtime monitoring off) go through UpdateDetector.
    "tamper-guardduty" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["guardduty.amazonaws.com"]
          eventName = [
            "DeleteDetector", "UpdateDetector", "UpdateMalwareScanSettings",
            "DisassociateFromMasterAccount", "DisassociateFromAdministratorAccount",
            "CreateFilter", "UpdateFilter", "CreateIPSet", "UpdateIPSet",
          ]
        }
      }
    }
    "tamper-resolver" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["route53resolver.amazonaws.com"]
          eventName = [
            "DeleteFirewallRuleGroup", "DisassociateFirewallRuleGroup", "UpdateFirewallRule", "DeleteFirewallRule",
            "UpdateFirewallRuleGroupAssociation", "UpdateFirewallDomains", "DeleteFirewallDomainList", "UpdateFirewallConfig",
            "DeleteResolverQueryLogConfig", "DisassociateResolverQueryLogConfig",
          ]
        }
      }
    }
    "tamper-flow-logs" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["ec2.amazonaws.com"]
          eventName   = ["DeleteFlowLogs"]
        }
      }
    }
    "tamper-kms" = {
      kind                  = "cloudtrail"
      all_management_events = false
      pattern = {
        "detail-type" = [local.api_call]
        detail = {
          eventSource = ["kms.amazonaws.com"]
          "$or" = [
            { eventName = ["PutKeyPolicy", "ScheduleKeyDeletion", "DisableKey", "DisableKeyRotation"] },
            { eventName = ["RevokeGrant", "RetireGrant"], resources = { ARN = local.module_key_arns } },
            # A grant a service makes on the caller's behalf (ECR at repository
            # creation) carries invokedBy; a grant a principal makes directly does not.
            { eventName = ["CreateGrant"], resources = { ARN = local.module_key_arns }, userIdentity = { invokedBy = [{ exists = false }] } },
            { eventName = ["CreateAlias", "UpdateAlias", "DeleteAlias"], requestParameters = { aliasName = local.module_alias_names } },
          ]
        }
      }
    }
  })

  global_alert_rules = merge(
    { for name, rule in merge(local.sts_rules, local.alert_path_tamper_rules) : name => rule if !local.global_in_main_topic },
    {
      "iam-role-change" = {
        kind                  = "cloudtrail"
        all_management_events = false
        pattern = {
          "detail-type" = [local.api_call]
          detail = {
            eventSource = ["iam.amazonaws.com"]
            eventName = [
              "UpdateAssumeRolePolicy", "PutRolePolicy", "AttachRolePolicy", "DetachRolePolicy", "DeleteRolePolicy",
              "PutRolePermissionsBoundary", "DeleteRolePermissionsBoundary", "UpdateRole", "DeleteRole",
            ]
            requestParameters = { roleName = local.module_role_names }
          }
        }
      }
      "iam-access-key-created" = {
        kind                  = "cloudtrail"
        all_management_events = false
        pattern = {
          "detail-type" = [local.api_call]
          detail = {
            eventSource = ["iam.amazonaws.com"]
            eventName   = ["CreateAccessKey"]
          }
        }
      }
      "root-console-login" = {
        kind                  = "cloudtrail"
        all_management_events = false
        pattern = {
          "detail-type" = ["AWS Console Sign In via CloudTrail"]
          detail = {
            eventName    = ["ConsoleLogin"]
            userIdentity = { type = ["Root"] }
          }
        }
      }
    },
  )

  # Per-source transformers: named fields only (see the header). The template is
  # a quoted JSON string written by hand: jsonencode would escape the <field>
  # placeholders. It holds no quote or backslash.
  alert_input = {
    cloudtrail = {
      paths = {
        eventName = "$.detail.eventName"
        eventID   = "$.detail.eventID"
        eventTime = "$.detail.eventTime"
        region    = "$.detail.awsRegion"
        principal = "$.detail.userIdentity.arn"
        resource  = "$.detail.resources[0].ARN"
      }
      template = "<eventName> by <principal> on <resource> at <eventTime> in <region>, CloudTrail event <eventID>. The full record is in CloudTrail."
    }
    guardduty = {
      paths = {
        type     = "$.detail.type"
        severity = "$.detail.severity"
        id       = "$.detail.id"
        region   = "$.region"
      }
      template = "GuardDuty finding <type>, severity <severity>, finding <id> in <region>. The full finding is in GuardDuty."
    }
  }

  global_alert_topic_arn = local.global_in_main_topic ? aws_sns_topic.alerts.arn : aws_sns_topic.global_alerts[0].arn
}

# Topics and subscriptions ------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

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

resource "aws_sns_topic_subscription" "owner" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_sns_topic_subscription" "cco" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.cco_alarm_email
}

# The global-service rules' topic, in us-east-1, when the region is elsewhere.
resource "aws_sns_topic" "global_alerts" {
  count    = local.global_in_main_topic ? 0 : 1
  provider = aws.us_east_1

  name = "${local.name}-global-alerts"
}

resource "aws_sns_topic_policy" "global_alerts" {
  count    = local.global_in_main_topic ? 0 : 1
  provider = aws.us_east_1

  arn = aws_sns_topic.global_alerts[0].arn

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
        Resource = aws_sns_topic.global_alerts[0].arn
      },
      {
        Sid       = "EventBridgePublishes"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.global_alerts[0].arn
        Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id } }
      },
    ]
  })
}

resource "aws_sns_topic_subscription" "global_owner" {
  count    = local.global_in_main_topic ? 0 : 1
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.global_alerts[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_sns_topic_subscription" "global_cco" {
  count    = local.global_in_main_topic ? 0 : 1
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.global_alerts[0].arn
  protocol  = "email"
  endpoint  = var.cco_alarm_email
}

# Rules and targets -----------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "regional" {
  for_each = local.regional_alert_rules

  name          = "conductia-discovery-${each.key}"
  description   = "Conductia discovery worker alert: ${each.key} (owner and CCO)"
  event_pattern = jsonencode(each.value.pattern)
  # Read-only management events (GetSecretValue, AssumeRole) reach only a rule
  # in this state.
  state = each.value.all_management_events ? "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS" : "ENABLED"
}

resource "aws_cloudwatch_event_target" "regional" {
  for_each = local.regional_alert_rules

  rule      = aws_cloudwatch_event_rule.regional[each.key].name
  target_id = "owner-and-cco"
  arn       = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths    = local.alert_input[each.value.kind].paths
    input_template = "\"Conductia discovery worker alert ${each.key}: ${local.alert_input[each.value.kind].template}\""
  }
}

resource "aws_cloudwatch_event_rule" "global" {
  for_each = local.global_alert_rules
  provider = aws.us_east_1

  name          = "conductia-discovery-${each.key}"
  description   = "Conductia discovery worker alert: ${each.key} (owner and CCO)"
  event_pattern = jsonencode(each.value.pattern)
  state         = each.value.all_management_events ? "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS" : "ENABLED"
}

resource "aws_cloudwatch_event_target" "global" {
  for_each = local.global_alert_rules
  provider = aws.us_east_1

  rule      = aws_cloudwatch_event_rule.global[each.key].name
  target_id = "owner-and-cco"
  arn       = local.global_alert_topic_arn

  input_transformer {
    input_paths    = local.alert_input[each.value.kind].paths
    input_template = "\"Conductia discovery worker alert ${each.key}: ${local.alert_input[each.value.kind].template}\""
  }
}
