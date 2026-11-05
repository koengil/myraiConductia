# The launcher guard (design R21): one explicit-Deny policy that stops a principal
# changing the launcher, its role, key, key parameter, schedule, logs, alarms,
# audit rules, alert topic, launch template and security group, reading a deploy
# VM's user data, or dressing an instance up as a deploy VM. An explicit Deny
# beats every Allow, so it holds even if a broad managed policy is attached later.
#
# A Lambda function policy only holds Allows, a role's trust policy only governs
# AssumeRole, and an SCP needs an AWS Organization (O17), so this is enforced on
# the principal side. This module attaches the guard to the CI fleet's instance,
# wake and scheduler roles (by name, below). The owner attaches the same managed
# policy to every other principal in the account that is not a launcher admin
# (O16). The admins (var.launcher_admin_arns, O15) never carry it.
#
# The launcher's own role carries a variant (local.launcher_guard_variant,
# attached in launcher.tf): the same denies minus what the launcher needs, which
# is its own log streams, ssm:GetParameter on the App key, kms:Decrypt on the App
# key (NotAction, still bounded by the key policy's SSM and parameter conditions)
# and ec2:TerminateInstances on its own VMs; and without the tag denies, since
# the launcher is the one principal that tags deploy VMs.
#
# Resource-level support, checked against the Service Authorization Reference
# (2026-10-22): ec2:DescribeInstanceAttribute, ec2:GetLaunchTemplateData,
# ec2:GetConsoleOutput and ec2:GetConsoleScreenshot each authorize on the
# instance resource (required) and accept ec2:ResourceTag/<key>, so their deny
# is keyed on Component = deploy-runner rather than Resource "*". The same
# reference lists iam:PolicyARN on the three Detach*Policy actions and
# cloudwatch:namespace on PutMetricData. Keying on the tag matters for the CI operator (O16):
# the AWS provider reads instance attributes with DescribeInstanceAttribute on
# every refresh of infra/ci-runner, and a deny on "*" would break its plans. A
# guarded principal cannot move that tag either (DenyDeployRetag).
#
# Neither module declares an exclusive policy list (no aws_iam_policy_attachment,
# no *_exclusive resource, no managed_policy_arns), so these attachments and the
# ci-runner module's own never undo each other. Both test suites pin that.

locals {
  guard_name = "conductia-deploy-launcher-guard"
  # Built from the name: the guard's detach deny names the guard itself.
  guard_policy_arn = "arn:aws:iam::${var.aws_account_id}:policy/${local.guard_name}"

  # The CI fleet's roles (infra/ci-runner/iam.tf: ${local.name}-instance,
  # local.wake_name, ${local.name}-scheduler). Attachment takes the role name, not
  # its /ci-runner/ path; ci-runner.tftest.hcl pins the same three names.
  guarded_fleet_roles = [
    "conductia-ci-runner-instance",
    "conductia-ci-runner-wake",
    "conductia-ci-runner-scheduler",
  ]

  # Built from names, so the launcher's own variant can name them without a
  # dependency cycle (the function depends on its role's policies).
  launcher_function_arn = "arn:aws:lambda:${var.region}:${var.aws_account_id}:function:${local.launcher_name}"
  launcher_schedule_arn = "arn:aws:scheduler:${var.region}:${var.aws_account_id}:schedule/default/${local.launcher_name}"
  app_key_alias_arn     = "arn:aws:kms:${var.region}:${var.aws_account_id}:alias/${local.name}"
  app_key_path_arn      = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter/conductia/deploy-runner"
  deploy_prefix         = "conductia-deploy-"
  ec2_prefix            = "arn:aws:ec2:${var.region}:${var.aws_account_id}"

  deploy_tagged = { StringEquals = { "ec2:ResourceTag/Component" = local.component } }

  # Each statement once, then the two policies pick and trim them.
  guard_statements = {
    LauncherFunction = {
      Action = [
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:DeleteFunction",
        "lambda:PublishVersion",
        "lambda:CreateAlias",
        "lambda:UpdateAlias",
        "lambda:CreateFunctionUrlConfig",
        "lambda:UpdateFunctionUrlConfig",
        "lambda:PutFunctionEventInvokeConfig",
        "lambda:UpdateFunctionEventInvokeConfig",
        "lambda:DeleteFunctionEventInvokeConfig",
      ]
      Resource = [local.launcher_function_arn, "${local.launcher_function_arn}:*"]
    }
    # The launcher role and its inline policies (PutRolePolicy and friends act on
    # the role ARN; so does PassRole, which would hand the role to a new
    # function), the schedule's role (audit V9: without its invoke permission or
    # its trust, the schedule stops invoking the launcher, and nothing alarms on
    # a launcher that is never invoked), and the guard itself: its versions and
    # its deletion.
    LauncherRoleAndGuard = {
      Action   = "iam:*"
      Resource = [aws_iam_role.launcher.arn, aws_iam_role.scheduler.arn, local.guard_policy_arn]
    }
    # A detach call's resource is the principal, not the policy, so the line
    # above alone would not stop a guarded principal removing its own guard
    # (review 1, #9).
    GuardDetach = {
      Action    = ["iam:DetachRolePolicy", "iam:DetachUserPolicy", "iam:DetachGroupPolicy"]
      Resource  = "*"
      Condition = { ArnEquals = { "iam:PolicyARN" = local.guard_policy_arn } }
    }
    # Action comes from the overlays below: kms:* in the guard, everything but
    # kms:Decrypt in the launcher's variant.
    AppKmsKey = {
      Resource = [aws_kms_key.app_key.arn, local.app_key_alias_arn]
    }
    AppKeyParameter = {
      Action = [
        "ssm:GetParameter*",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:DeleteParameters",
        "ssm:LabelParameterVersion",
      ]
      Resource = [local.app_key_parameter_arn, local.app_key_path_arn]
    }
    LauncherSchedule = {
      Action   = ["scheduler:UpdateSchedule", "scheduler:DeleteSchedule"]
      Resource = local.launcher_schedule_arn
    }
    # The fleet's CloudWatchAgentServerPolicy may write to and change retention
    # on every log group in the account (research §3); without this a PR job
    # could forge or shorten the launcher's log. A KMS key associated with the
    # group, then disabled, would stop the launcher logging at all.
    LauncherLogs = {
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:PutRetentionPolicy",
        "logs:DeleteLogGroup",
        "logs:DeleteLogStream",
        "logs:PutMetricFilter",
        "logs:DeleteMetricFilter",
        "logs:AssociateKmsKey",
        "logs:DisassociateKmsKey",
      ]
      Resource = [aws_cloudwatch_log_group.launcher.arn, "${aws_cloudwatch_log_group.launcher.arn}:*"]
    }
    # The same agent policy may put metric data anywhere. A negative datapoint in
    # the alarms' namespace would cancel the metric filters' 1s, so a Sum >= 1
    # alarm never fires.
    AlarmMetrics = {
      Action    = "cloudwatch:PutMetricData"
      Resource  = "*"
      Condition = { StringEquals = { "cloudwatch:namespace" = local.metric_namespace } }
    }
    Alarms = {
      Action   = ["cloudwatch:DeleteAlarms", "cloudwatch:DisableAlarmActions", "cloudwatch:SetAlarmState", "cloudwatch:PutMetricAlarm"]
      Resource = "arn:aws:cloudwatch:${var.region}:${var.aws_account_id}:alarm:${local.deploy_prefix}*"
    }
    # The audit rules arrive in PR C; the guard names their prefix, not them.
    AuditRules = {
      Action   = ["events:PutRule", "events:DeleteRule", "events:DisableRule", "events:PutTargets", "events:RemoveTargets"]
      Resource = "arn:aws:events:${var.region}:${var.aws_account_id}:rule/${local.deploy_prefix}*"
    }
    # Everything on the alert topic and its subscriptions but Publish.
    AlertTopic = {
      NotAction = "sns:Publish"
      Resource  = [aws_sns_topic.alerts.arn, "${aws_sns_topic.alerts.arn}:*"]
    }
    # A deploy VM's user data holds its JIT config until the VM ends (review 1, #4).
    DeployVmUserData = {
      Action    = ["ec2:DescribeInstanceAttribute", "ec2:GetLaunchTemplateData", "ec2:GetConsoleOutput", "ec2:GetConsoleScreenshot"]
      Resource  = "${local.ec2_prefix}:instance/*"
      Condition = local.deploy_tagged
    }
    # A new group, a stop (an API stop keeps the disk, unlike the VM's own
    # shutdown) or an early terminate of a VM that may be running a migration.
    # Audit V7: also a role handed to the VM (with an SSM-capable profile, a
    # session gives root during a job holding production secrets), a copy of its
    # disk, a disk swapped in or out, its metadata options loosened, or a reboot.
    # Each is keyed on the deploy tag of the instance or volume it acts on.
    DeployVmChanges = {
      Action = [
        "ec2:ModifyInstanceAttribute",
        "ec2:ModifyNetworkInterfaceAttribute",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
        "ec2:RebootInstances",
        "ec2:ModifyInstanceMetadataOptions",
        "ec2:AssociateIamInstanceProfile",
        "ec2:ReplaceIamInstanceProfileAssociation",
        "ec2:DisassociateIamInstanceProfile",
        "ec2:CreateImage",
        "ec2:CreateSnapshot",
        "ec2:CreateSnapshots",
        "ec2:AttachVolume",
        "ec2:DetachVolume",
      ]
      Resource  = ["${local.ec2_prefix}:instance/*", "${local.ec2_prefix}:network-interface/*", "${local.ec2_prefix}:volume/*"]
      Condition = local.deploy_tagged
    }
    LaunchTemplate = {
      Action   = ["ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:DeleteLaunchTemplateVersions"]
      Resource = aws_launch_template.deploy.arn
    }
    SecurityGroup = {
      Action = [
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:ModifySecurityGroupRules",
        "ec2:DeleteSecurityGroup",
      ]
      Resource = aws_security_group.deploy.arn
    }
    # No guarded principal can make an instance look like a deploy VM (round 2,
    # #9), nor strip or overwrite a real one's tag. aws:ec2launchtemplate:id needs
    # no deny: AWS reserves the aws: prefix, and only a launch from the deploy
    # template carries it.
    DeployTagForge = {
      Action    = ["ec2:CreateTags", "ec2:RunInstances"]
      Resource  = "*"
      Condition = { StringEquals = { "aws:RequestTag/Component" = local.component } }
    }
    RunnerIdForge = {
      Action    = ["ec2:CreateTags", "ec2:RunInstances"]
      Resource  = "*"
      Condition = { "ForAnyValue:StringEquals" = { "aws:TagKeys" = "RunnerId" } }
    }
    DeployRetag = {
      Action    = ["ec2:CreateTags", "ec2:DeleteTags"]
      Resource  = "*"
      Condition = local.deploy_tagged
    }
  }

  guard_overlay = {
    AppKmsKey = { Action = "kms:*" }
  }

  guard_policy = {
    Version = "2012-10-17"
    Statement = [
      for sid, s in local.guard_statements : merge({ Sid = sid, Effect = "Deny" }, s, try(local.guard_overlay[sid], {}))
    ]
  }

  # What the launcher itself calls, and so must keep (lambda/deploy.mjs): its own
  # log streams, the App key read and its decrypt, and terminate of its own VMs.
  # Launch, tag on create and describe are in no statement it carries.
  launcher_overlay = {
    LauncherLogs = {
      Action = [for a in local.guard_statements.LauncherLogs.Action : a if !contains(["logs:CreateLogStream", "logs:PutLogEvents"], a)]
    }
    AppKeyParameter = {
      Action = [
        "ssm:GetParameters",
        "ssm:GetParameterHistory",
        "ssm:GetParametersByPath",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:DeleteParameters",
        "ssm:LabelParameterVersion",
      ]
    }
    DeployVmChanges = {
      Action = [for a in local.guard_statements.DeployVmChanges.Action : a if a != "ec2:TerminateInstances"]
    }
    # An explicit Deny beats the key policy's Allow, so kms:* would stop the
    # launcher decrypting its own key (review 1, #3). The Decrypt it keeps is
    # still bounded by LauncherDecryptViaSsm (kms.tf): through SSM, for the App
    # key parameter only.
    AppKmsKey = { NotAction = "kms:Decrypt" }
  }

  # The launcher tags its own VMs, so the three tag statements are not in it.
  launcher_guard_variant = {
    Version = "2012-10-17"
    Statement = [
      for sid, s in local.guard_statements : merge({ Sid = sid, Effect = "Deny" }, s, try(local.launcher_overlay[sid], {}))
      if !contains(["DeployTagForge", "RunnerIdForge", "DeployRetag"], sid)
    ]
  }
}

resource "aws_iam_policy" "launcher_guard" {
  name        = local.guard_name
  description = "Explicit deny: nothing but a launcher admin changes the deploy runner launcher (ADR-0028, design R21). Attach to every non-admin principal (O16)."
  policy      = jsonencode(local.guard_policy)

  lifecycle {
    postcondition {
      condition     = self.arn == local.guard_policy_arn
      error_message = "The guard's ARN must be ${local.guard_policy_arn}: its detach deny names it."
    }
  }
}

# By role name, one attachment per role; never an exclusive list.
resource "aws_iam_role_policy_attachment" "launcher_guard" {
  for_each = toset(local.guarded_fleet_roles)

  role       = each.value
  policy_arn = aws_iam_policy.launcher_guard.arn
}
