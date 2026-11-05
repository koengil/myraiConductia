# Offline plan tests for infra/deploy-runner (#639, ADR-0028, design R10). The
# AWS provider is a mock (no account, no credentials, no network call); the
# archive provider is mocked so no zip is written. Run by scripts/infra/validate.sh.

mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = {
      id = "vpc-0123456789abcdef0"
    }
  }
  mock_data "aws_subnet" {
    defaults = {
      id  = "subnet-0123456789abcdef0"
      arn = "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123456789abcdef0"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
    }
  }
  mock_resource "aws_security_group" {
    defaults = {
      id  = "sg-0123456789abcdef0"
      arn = "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0"
    }
  }
  mock_resource "aws_launch_template" {
    defaults = {
      id             = "lt-0123456789abcdef0"
      arn            = "arn:aws:ec2:us-east-1:123456789012:launch-template/lt-0123456789abcdef0"
      latest_version = 4
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:conductia-deploy-runner-launch"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch"
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"
    }
  }
  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000"
      key_id = "00000000-0000-4000-8000-000000000000"
    }
  }
}

mock_provider "archive" {}

# The launcher role gets its own ARN, so the key policy can be checked against it.
override_resource {
  target = aws_iam_role.launcher
  values = {
    arn = "arn:aws:iam::123456789012:role/conductia-deploy-runner-launch"
  }
}

# The guard's ARN as AWS builds it from its name; its detach deny names it.
override_resource {
  target = aws_iam_role.scheduler
  values = {
    arn = "arn:aws:iam::123456789012:role/conductia-deploy-runner-scheduler"
  }
}

override_resource {
  target = aws_iam_policy.launcher_guard
  values = {
    arn = "arn:aws:iam::123456789012:policy/conductia-deploy-launcher-guard"
  }
}

variables {
  aws_account_id      = "123456789012"
  ami_id              = "ami-0123456789abcdef0"
  launcher_admin_arns = ["arn:aws:iam::123456789012:role/conductia-admin", "arn:aws:iam::123456789012:user/conductia-break-glass"]
}

run "vm_has_no_profile_and_no_ingress" {
  command = plan

  assert {
    condition     = length(aws_launch_template.deploy.iam_instance_profile) == 0
    error_message = "A deploy VM has no instance profile: a job on it gets no AWS credential."
  }
  assert {
    condition     = length(aws_security_group.deploy.ingress) == 0 && aws_vpc_security_group_egress_rule.deploy_all.cidr_ipv4 == "0.0.0.0/0"
    error_message = "The deploy group admits no ingress; egress is open (F3)."
  }
  assert {
    condition = (
      aws_launch_template.deploy.metadata_options[0].http_tokens == "required" &&
      aws_launch_template.deploy.metadata_options[0].http_put_response_hop_limit == 1 &&
      aws_launch_template.deploy.instance_initiated_shutdown_behavior == "terminate"
    )
    error_message = "IMDSv2 with hop limit 1, and a shutdown terminates the VM."
  }
  assert {
    condition = (
      aws_launch_template.deploy.network_interfaces[0].subnet_id == "subnet-0123456789abcdef0" &&
      aws_launch_template.deploy.network_interfaces[0].security_groups == toset(["sg-0123456789abcdef0"]) &&
      aws_launch_template.deploy.block_device_mappings[0].ebs[0].encrypted == "true"
    )
    error_message = "The template pins the CI fleet's public subnet, the deploy group and an encrypted root volume."
  }
  assert {
    condition = (
      toset([for t in aws_launch_template.deploy.tag_specifications : t.resource_type]) == toset(["instance", "volume", "network-interface"]) &&
      alltrue([for t in aws_launch_template.deploy.tag_specifications : t.tags.Component == "deploy-runner"])
    )
    error_message = "The template tags instance, volume and network interface with Component = deploy-runner."
  }
  assert {
    condition     = aws_launch_template.deploy.image_id == "ami-0123456789abcdef0" && aws_launch_template.deploy.instance_type == "m6a.large"
    error_message = "The AMI is the pinned variable, never a lookup."
  }
}

run "user_data_starts_runner_first" {
  command = plan

  # The rendered boot script, as the launcher ships it (launcher.tf, archive_file).
  assert {
    condition     = can(regex("^#!/bin/bash\\n(#[^\\n]*\\n)*shutdown -h \\+120\\n", local.user_data_script))
    error_message = "The first command is the 120-minute hard cap."
  }
  assert {
    condition = can(regex(
      "(?s)'ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/deploy/wait-toolchain\\.sh' \\\\\\n  'PATH=[^']*/usr/local/bin[^']*' \\\\\\n  > \"\\$dir/\\.env\"\\n.*\\./run\\.sh --jitconfig",
      local.user_data_script,
    ))
    error_message = ".env holds the job-started hook and a PATH with /usr/local/bin, and is written before run.sh starts."
  }
  assert {
    condition     = !can(regex("(?m)^\\s*(export\\s+)?ACTIONS_RUNNER_HOOK_JOB_STARTED=", local.user_data_script))
    error_message = "The hook is never a bare shell assignment: sudo would drop it (round 2, #2)."
  }
  assert {
    condition = (
      !can(regex("(?s)(apt-get install|nodejs\\.org|cli\\.github\\.com|install-deps chromium).*\\./run\\.sh --jitconfig", local.user_data_script)) &&
      can(regex("(?s)\\./run\\.sh --jitconfig.*touch /var/lib/deploy/toolchain-ready", local.user_data_script))
    )
    error_message = "run.sh starts before any toolchain install, and toolchain-ready is set after it."
  }
  assert {
    condition     = !can(regex("set -[a-zA-Z]*x", local.user_data_script)) && !can(regex("(?m)^\\s*set -o xtrace", local.user_data_script))
    error_message = "No xtrace: the JIT config must never reach the console."
  }
  assert {
    condition = (
      strcontains(local.user_data_script, "actions-runner-linux-x64-${var.runner_version}.tar.gz") &&
      strcontains(local.user_data_script, "releases/download/v${var.runner_version}/") &&
      strcontains(local.user_data_script, "echo \"${var.runner_sha256}  /tmp/$asset\" | sha256sum -c") &&
      !strcontains(local.user_data_script, "releases/latest")
    )
    error_message = "The runner is the pinned release, checked against runner_sha256 (round 2, #10)."
  }
  assert {
    condition = (
      strcontains(local.user_data_script, "https://nodejs.org/dist/v${var.node_version}/$file") &&
      strcontains(local.user_data_script, "echo \"${var.node_sha256}  $node_tmp/$file\" | sha256sum -c") &&
      strcontains(local.user_data_script, "npx -y playwright@${var.playwright_version} install-deps") &&
      var.playwright_version == jsondecode(file("${path.module}/../../package-lock.json")).packages["node_modules/@playwright/test"].version &&
      !strcontains(local.user_data_script, "latest-v") &&
      !can(regex("playwright@[0-9]+ ", local.user_data_script))
    )
    error_message = "Node and Playwright are pinned releases (audit V11): Node checked against node_sha256, Playwright the version package-lock.json resolves."
  }
  assert {
    condition = (
      strcontains(local.user_data_script, "curl -fsSL --retry 3 --max-time 300 -o \"/tmp/$asset\"") &&
      strcontains(local.user_data_script, "timeout 600 \"$dir/bin/installdependencies.sh\"")
    )
    error_message = "Every step before the runner starts is bounded, so a stall powers the VM off (audit V6)."
  }
  assert {
    condition     = !can(regex("sudo [^\\n]*--jitconfig \"\\$jit\"", local.user_data_script)) && strcontains(local.user_data_script, "exec ./run.sh --jitconfig \"$cfg\"")
    error_message = "The JIT config reaches run.sh through a runner-only file, never on sudo's command line (audit V15)."
  }
  assert {
    condition     = length(split("__JIT_CONFIG__", local.user_data_script)) == 2 && strcontains(local.user_data_script, "jit='__JIT_CONFIG__'")
    error_message = "The script holds the JIT placeholder exactly once, in single quotes."
  }
  assert {
    condition     = !strcontains(local.user_data_script, "docker") && strcontains(local.user_data_script, "shutdown -h now")
    error_message = "No Docker on a deploy VM, and it powers off when its one job ends."
  }
}

run "launcher_role_is_pinned" {
  command = plan

  assert {
    condition = toset([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s.Sid]) == toset([
      "WriteOwnLogs", "ReadAppKey", "RunFromTemplate", "RunTaggedParts", "RunTemplate", "RunPinnedInputs", "TagOnCreate", "Describe", "ReapOwn",
    ])
    error_message = "The launcher role holds exactly the R7 statements."
  }
  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s if s.Sid == "ReapOwn"]) == {
      Sid      = "ReapOwn"
      Effect   = "Allow"
      Action   = "ec2:TerminateInstances"
      Resource = "arn:aws:ec2:us-east-1:123456789012:instance/*"
      Condition = {
        StringEquals = {
          "ec2:ResourceTag/Component"                = "deploy-runner"
          "ec2:ResourceTag/aws:ec2launchtemplate:id" = "lt-0123456789abcdef0"
        }
      }
    }
    error_message = "TerminateInstances only on instances tagged Component = deploy-runner AND launched from the deploy template (round 2, #9)."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s
      if strcontains(jsonencode(s.Action), "TerminateInstances") || strcontains(jsonencode(s.Action), "ec2:*") || strcontains(jsonencode(s.Action), "\"*\"")
    ]) == 1
    error_message = "ReapOwn is the only statement that can terminate an instance."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s.Effect == "Allow"]) && one([
      for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s if s.Sid == "RunFromTemplate"
      ]) == {
      Sid      = "RunFromTemplate"
      Effect   = "Allow"
      Action   = "ec2:RunInstances"
      Resource = "arn:aws:ec2:us-east-1:123456789012:instance/*"
      Condition = {
        ArnEquals    = { "ec2:LaunchTemplate" = "arn:aws:ec2:us-east-1:123456789012:launch-template/lt-0123456789abcdef0" }
        StringEquals = { "aws:RequestTag/Component" = "deploy-runner", "ec2:InstanceType" = "m6a.large" }
      }
    }
    error_message = "Instances launch only from the deploy template, only as its instance type, and only tagged Component = deploy-runner."
  }
  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s if s.Sid == "RunTemplate"]) == {
      Sid      = "RunTemplate"
      Effect   = "Allow"
      Action   = "ec2:RunInstances"
      Resource = "arn:aws:ec2:us-east-1:123456789012:launch-template/lt-0123456789abcdef0"
    }
    error_message = "The template ARN is authorized on its own, with no condition (round 2, #7)."
  }
  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s if s.Sid == "RunPinnedInputs"]) == {
      Sid    = "RunPinnedInputs"
      Effect = "Allow"
      Action = "ec2:RunInstances"
      Resource = [
        "arn:aws:ec2:us-east-1::image/ami-0123456789abcdef0",
        "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123456789abcdef0",
        "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0",
      ]
      Condition = { Bool = { "ec2:IsLaunchTemplateResource" = "true" } }
    }
    error_message = "The AMI, subnet and group are usable only as the template supplies them, and the template ARN is not among them."
  }
  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s if s.Sid == "RunTaggedParts"]) == {
      Sid       = "RunTaggedParts"
      Effect    = "Allow"
      Action    = "ec2:RunInstances"
      Resource  = ["arn:aws:ec2:us-east-1:123456789012:volume/*", "arn:aws:ec2:us-east-1:123456789012:network-interface/*"]
      Condition = { StringEquals = { "aws:RequestTag/Component" = "deploy-runner" } }
    }
    error_message = "Volumes and network interfaces carry the deploy tag too."
  }
  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s if s.Sid == "TagOnCreate"]) == {
      Sid    = "TagOnCreate"
      Effect = "Allow"
      Action = "ec2:CreateTags"
      Resource = [
        "arn:aws:ec2:us-east-1:123456789012:instance/*",
        "arn:aws:ec2:us-east-1:123456789012:volume/*",
        "arn:aws:ec2:us-east-1:123456789012:network-interface/*",
      ]
      Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances" } }
    }
    error_message = "The launcher tags only what RunInstances creates."
  }
  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s.Resource if s.Sid == "ReadAppKey"]) == "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/deploy-runner/github-app-key" &&
      !strcontains(aws_iam_role_policy.launcher.policy, "iam:PassRole") &&
      !strcontains(aws_iam_role_policy.launcher.policy, "StopInstances") &&
      !strcontains(aws_iam_role_policy.launcher.policy, "\"kms:")
    )
    error_message = "The role reads only the App key parameter, passes no role, stops nothing, and gets KMS only from the key policy."
  }
  assert {
    condition     = jsondecode(aws_iam_role.launcher.assume_role_policy).Statement[0].Principal.Service == "lambda.amazonaws.com" && jsondecode(aws_iam_role.launcher.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    error_message = "Only Lambda in this account assumes the launcher role."
  }
}

run "template_version_pinned" {
  command = plan

  assert {
    condition = (
      aws_lambda_function.launcher.environment[0].variables.LAUNCH_TEMPLATE_VERSION == tostring(aws_launch_template.deploy.latest_version) &&
      aws_lambda_function.launcher.environment[0].variables.TEMPLATE_ID == aws_launch_template.deploy.id
    )
    error_message = "The launcher passes the template id and the version tofu pinned, never $Default or $Latest."
  }
  assert {
    condition = (
      aws_lambda_function.launcher.environment[0].variables.GROUP_NAME == "conductia-deploy" &&
      aws_lambda_function.launcher.environment[0].variables.RUNNER_LABELS == "conductia-deploy,self-hosted,Linux,X64" &&
      aws_lambda_function.launcher.environment[0].variables.REPO == "Conductia/Conductia" &&
      aws_lambda_function.launcher.environment[0].variables.APP_KEY_PARAM == "/conductia/deploy-runner/github-app-key" &&
      aws_lambda_function.launcher.environment[0].variables.CAP == "3" &&
      length(jsondecode(aws_lambda_function.launcher.environment[0].variables.ALLOWLIST)) == 8
    )
    error_message = "The launcher's configuration comes from the variables."
  }
  assert {
    condition     = aws_lambda_function.launcher.timeout < 60 && aws_lambda_function.launcher.runtime == "nodejs22.x" && aws_lambda_function.launcher.handler == "deploy.handler"
    error_message = "A tick ends before the next one starts."
  }
  assert {
    condition = (
      aws_lambda_function.launcher.reserved_concurrent_executions == 1 &&
      aws_lambda_function_event_invoke_config.launcher.function_name == aws_lambda_function.launcher.function_name &&
      aws_lambda_function_event_invoke_config.launcher.maximum_retry_attempts == 0 &&
      aws_lambda_function_event_invoke_config.launcher.maximum_event_age_in_seconds == 60 &&
      aws_scheduler_schedule.launcher.target[0].retry_policy[0].maximum_retry_attempts == 0
    )
    error_message = "Two ticks never overlap (audit V2): one concurrent execution, no Lambda async retries, a throttled event dropped within 60 s, and no Scheduler retries."
  }
}

run "json_logs" {
  command = plan

  assert {
    condition     = aws_lambda_function.launcher.logging_config[0].log_format == "JSON" && aws_lambda_function.launcher.logging_config[0].log_group == "/aws/lambda/conductia-deploy-runner-launch"
    error_message = "The launcher logs JSON to its own log group, so metric filters can match $.message.event."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.launcher.policy).Statement : s.Resource if s.Sid == "WriteOwnLogs"]) == "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch:*"
    error_message = "The launcher writes only its own log group."
  }
}

run "no_ssm_parameter_in_module" {
  command = plan

  assert {
    condition = !can(regex(
      "(resource|data)\\s+\"aws_ssm_parameter\"",
      join("\n", [for f in fileset(path.module, "**/*.tf") : file("${path.module}/${f}")]),
    ))
    error_message = "No aws_ssm_parameter resource or data source: either would read the App key with decryption on refresh (review 1, #15)."
  }
}

run "app_key_readable_only_by_launcher" {
  command = plan

  assert {
    condition     = !strcontains(aws_kms_key.app_key.policy, ":root") && aws_kms_key.app_key.enable_key_rotation && aws_kms_key.app_key.deletion_window_in_days == 30 && aws_kms_alias.app_key.name == "alias/conductia-deploy-runner"
    error_message = "No account-root statement, rotation on, 30-day deletion window, alias/conductia-deploy-runner."
  }
  assert {
    condition = [
      for s in jsondecode(aws_kms_key.app_key.policy).Statement : s.Principal.AWS
      if s.Effect == "Allow" && contains(flatten([s.Action]), "kms:Decrypt")
    ] == ["arn:aws:iam::123456789012:role/conductia-deploy-runner-launch"]
    error_message = "The launcher role is the only Decrypt allow."
  }
  assert {
    condition = one([for s in jsondecode(aws_kms_key.app_key.policy).Statement : s.Condition if s.Sid == "LauncherDecryptViaSsm"]) == {
      StringEquals = {
        "kms:ViaService"                      = "ssm.us-east-1.amazonaws.com"
        "kms:EncryptionContext:PARAMETER_ARN" = "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/deploy-runner/github-app-key"
      }
    }
    error_message = "The launcher decrypts only through SSM, and only the App key parameter."
  }
  assert {
    condition = one([for s in jsondecode(aws_kms_key.app_key.policy).Statement : s if s.Sid == "DenyDecryptToOthers"]) == {
      Sid       = "DenyDecryptToOthers"
      Effect    = "Deny"
      Principal = { AWS = "*" }
      Action    = ["kms:Decrypt", "kms:ReEncrypt*"]
      Resource  = "*"
      Condition = { ArnNotEquals = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/conductia-deploy-runner-launch" } }
    } && one([for s in jsondecode(aws_kms_key.app_key.policy).Statement : s.Action if s.Sid == "DenyGrants" && s.Effect == "Deny"]) == "kms:CreateGrant"
    error_message = "Decrypt is denied to everyone but the launcher, and grants to all."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_kms_key.app_key.policy).Statement :
      !contains(flatten([s.Action]), "kms:Decrypt") && !contains(flatten([s.Action]), "kms:CreateGrant") && !contains(flatten([s.Action]), "kms:*")
      if s.Effect == "Allow" && s.Sid != "LauncherDecryptViaSsm"
      ]) && alltrue([
      for s in jsondecode(aws_kms_key.app_key.policy).Statement : s.Principal.AWS == var.launcher_admin_arns
      if startswith(s.Sid, "Admin")
    ])
    error_message = "The admin statements name exactly launcher_admin_arns and grant neither Decrypt nor CreateGrant."
  }
  assert {
    condition     = one([for s in jsondecode(aws_kms_key.app_key.policy).Statement : s.Condition.StringEquals["kms:ViaService"] if s.Sid == "AdminRotateViaSsm"]) == "ssm.us-east-1.amazonaws.com"
    error_message = "Admins encrypt a rotated key only through SSM."
  }
}

run "alert_topic_policy" {
  command = plan

  assert {
    condition     = aws_sns_topic.alerts.name == "conductia-deploy-runner-alerts" && aws_sns_topic.alerts.kms_master_key_id == null
    error_message = "One topic, conductia-deploy-runner-alerts, unencrypted on purpose: disabling a key must not silence its own alert."
  }
  assert {
    condition = one([for s in jsondecode(aws_sns_topic_policy.alerts.policy).Statement : s if s.Sid == "AccountIamPolicies"]) == {
      Sid       = "AccountIamPolicies"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::123456789012:root" }
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
      Resource = "arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"
    }
    error_message = "The account statement keeps the default topic actions for this account's IAM policies."
  }
  assert {
    condition = one([for s in jsondecode(aws_sns_topic_policy.alerts.policy).Statement : s if s.Sid == "EventBridgeAndAlarmsPublish"]) == {
      Sid       = "EventBridgeAndAlarmsPublish"
      Effect    = "Allow"
      Principal = { Service = ["events.amazonaws.com", "cloudwatch.amazonaws.com"] }
      Action    = "sns:Publish"
      Resource  = "arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"
      Condition = { StringEquals = { "aws:SourceAccount" = "123456789012" } }
    }
    error_message = "EventBridge and CloudWatch alarms both publish, from this account only (review 1, #8): events alone would silence every alarm."
  }
  assert {
    condition     = length(jsondecode(aws_sns_topic_policy.alerts.policy).Statement) == 2 && aws_sns_topic_policy.alerts.arn == aws_sns_topic.alerts.arn
    error_message = "The topic policy holds exactly the two statements, on this topic."
  }
  assert {
    condition     = output.deploy_alerts_topic_arn == "arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"
    error_message = "O10 subscribes to the deploy_alerts_topic_arn output."
  }
}

run "tripwire_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.tripwire.log_group_name == "/aws/lambda/conductia-deploy-runner-launch" &&
      aws_cloudwatch_log_metric_filter.tripwire.pattern == "{ ($.message.event = \"deploy_tripwire\") || ($.message.event = \"deploy_blind\") || (($.message.event = \"deploy_selfcheck\") && ($.message.run_instances = \"denied\")) }"
    )
    error_message = "The filter matches every deploy_tripwire record on $.message.event (JSON logs), every deploy_blind record (audit V1), and a denied self-check (round 2, #7)."
  }
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.tripwire.metric_transformation[0].name == "DeployTripwire" &&
      aws_cloudwatch_log_metric_filter.tripwire.metric_transformation[0].namespace == "Conductia/DeployRunner" &&
      aws_cloudwatch_log_metric_filter.tripwire.metric_transformation[0].value == "1"
    )
    error_message = "Each matching record counts 1 to DeployTripwire."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.tripwire.metric_name == "DeployTripwire" &&
      aws_cloudwatch_metric_alarm.tripwire.namespace == "Conductia/DeployRunner" &&
      aws_cloudwatch_metric_alarm.tripwire.statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.tripwire.period == 60 &&
      aws_cloudwatch_metric_alarm.tripwire.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.tripwire.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.tripwire.threshold == 1 &&
      aws_cloudwatch_metric_alarm.tripwire.treat_missing_data == "notBreaching"
    )
    error_message = "The tripwire alarms on Maximum >= 1 over 60 s (audit V13), and missing data is not breaching."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.tripwire.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"]) && startswith(aws_cloudwatch_metric_alarm.tripwire.alarm_name, "conductia-deploy-")
    error_message = "The tripwire notifies the deploy alert topic, under a conductia-deploy-* name (the guard and R22 (d) cover that prefix)."
  }
}

run "hold_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.hold.log_group_name == "/aws/lambda/conductia-deploy-runner-launch" &&
      aws_cloudwatch_log_metric_filter.hold.pattern == "{ ($.message.event = \"deploy_hold\") && ($.message.admitted_waiting > 0) }" &&
      aws_cloudwatch_log_metric_filter.hold.metric_transformation[0].name == "DeployHeldWithAdmittedWaiting" &&
      aws_cloudwatch_log_metric_filter.hold.metric_transformation[0].value == "1"
    )
    error_message = "The hold filter matches deploy_hold records with admitted jobs waiting, on $.message (round 2, #5)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.hold.metric_name == "DeployHeldWithAdmittedWaiting" &&
      aws_cloudwatch_metric_alarm.hold.statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.hold.period == 60 &&
      aws_cloudwatch_metric_alarm.hold.evaluation_periods == 10 &&
      aws_cloudwatch_metric_alarm.hold.datapoints_to_alarm == 10 &&
      aws_cloudwatch_metric_alarm.hold.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.hold.threshold == 1 &&
      aws_cloudwatch_metric_alarm.hold.treat_missing_data == "notBreaching"
    )
    error_message = "The hold alarms after 10 of 10 breaching one-minute periods."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.hold.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"]) && startswith(aws_cloudwatch_metric_alarm.hold.alarm_name, "conductia-deploy-")
    error_message = "The hold alarm notifies the same topic, under a conductia-deploy-* name."
  }
}

run "unknown_runner_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.unknown_runner.log_group_name == "/aws/lambda/conductia-deploy-runner-launch" &&
      aws_cloudwatch_log_metric_filter.unknown_runner.pattern == "{ $.message.event = \"deploy_unknown_runner\" }" &&
      aws_cloudwatch_log_metric_filter.unknown_runner.metric_transformation[0].name == "DeployUnknownRunner" &&
      aws_cloudwatch_log_metric_filter.unknown_runner.metric_transformation[0].namespace == "Conductia/DeployRunner" &&
      aws_cloudwatch_log_metric_filter.unknown_runner.metric_transformation[0].value == "1"
    )
    error_message = "The unknown-runner filter matches deploy_unknown_runner records on $.message.event (design R23)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.unknown_runner.metric_name == "DeployUnknownRunner" &&
      aws_cloudwatch_metric_alarm.unknown_runner.namespace == "Conductia/DeployRunner" &&
      aws_cloudwatch_metric_alarm.unknown_runner.statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.unknown_runner.period == 60 &&
      aws_cloudwatch_metric_alarm.unknown_runner.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.unknown_runner.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.unknown_runner.threshold == 1 &&
      aws_cloudwatch_metric_alarm.unknown_runner.treat_missing_data == "notBreaching"
    )
    error_message = "The unknown-runner alarm fires on Maximum >= 1 over 60 s (audit V13), and missing data is not breaching."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.unknown_runner.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"]) && aws_cloudwatch_metric_alarm.unknown_runner.alarm_name == "conductia-deploy-runner-unknown-runner"
    error_message = "The unknown-runner alarm notifies the deploy alert topic, under its own conductia-deploy-* name."
  }
}

run "launcher_errors_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.launcher_errors.namespace == "AWS/Lambda" &&
      aws_cloudwatch_metric_alarm.launcher_errors.metric_name == "Errors" &&
      aws_cloudwatch_metric_alarm.launcher_errors.dimensions == tomap({ FunctionName = "conductia-deploy-runner-launch" }) &&
      aws_cloudwatch_metric_alarm.launcher_errors.dimensions.FunctionName == aws_lambda_function.launcher.function_name
    )
    error_message = "The alarm watches AWS/Lambda Errors of the launcher function, by its FunctionName and nothing else."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.launcher_errors.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.launcher_errors.period == 60 &&
      aws_cloudwatch_metric_alarm.launcher_errors.evaluation_periods == 5 &&
      aws_cloudwatch_metric_alarm.launcher_errors.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.launcher_errors.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.launcher_errors.threshold == 1 &&
      aws_cloudwatch_metric_alarm.launcher_errors.treat_missing_data == "notBreaching"
    )
    error_message = "The alarm fires on 3 failed one-minute ticks of 5, and a dormant launcher (no invocations) is not breaching."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.launcher_errors.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"]) &&
      aws_cloudwatch_metric_alarm.launcher_errors.ok_actions == toset(["arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts"]) &&
      aws_cloudwatch_metric_alarm.launcher_errors.alarm_name == "conductia-deploy-runner-launcher-errors"
    )
    error_message = "The alarm and its recovery notify the deploy alert topic, under its own conductia-deploy-* name."
  }

  # The guard names alarms by prefix, not one by one: pin that its Alarms deny
  # (and the launcher variant's, the same statement) covers this alarm's ARN.
  assert {
    condition = alltrue([
      for p in [aws_iam_policy.launcher_guard.policy, aws_iam_role_policy.launcher_guard.policy] : anytrue([
        for s in jsondecode(p).Statement :
        s.Effect == "Deny" &&
        contains(flatten([try(s.Action, [])]), "cloudwatch:DeleteAlarms") &&
        contains(flatten([try(s.Action, [])]), "cloudwatch:DisableAlarmActions") &&
        contains(flatten([try(s.Action, [])]), "cloudwatch:SetAlarmState") &&
        contains(flatten([try(s.Action, [])]), "cloudwatch:PutMetricAlarm") &&
        anytrue([
          for r in flatten([s.Resource]) :
          endswith(r, "*") && startswith("arn:aws:cloudwatch:us-east-1:123456789012:alarm:${aws_cloudwatch_metric_alarm.launcher_errors.alarm_name}", trimsuffix(r, "*"))
        ])
      ])
    ])
    error_message = "The guard and the launcher's variant deny deleting, disabling, setting the state of or replacing the Errors alarm."
  }
}

run "allowlist_rejects_bad_expiry" {
  command = plan

  variables {
    deploy_allowlist = [
      { workflow = ".github/workflows/migrate.yml", branch = "develop", events = ["workflow_dispatch"], expires = "2026-10-25" },
    ]
  }

  expect_failures = [var.deploy_allowlist]
}

run "allowlist_rejects_unknown_workflow" {
  command = plan

  variables {
    deploy_allowlist = [
      { workflow = ".github/workflows/ci.yml", branch = "main", events = ["workflow_dispatch"] },
    ]
  }

  expect_failures = [var.deploy_allowlist]
}

run "allowlist_rejects_pull_request_event" {
  command = plan

  variables {
    deploy_allowlist = [
      { workflow = ".github/workflows/migrate.yml", branch = "main", events = ["pull_request"] },
    ]
  }

  expect_failures = [var.deploy_allowlist]
}

run "disabled_by_default" {
  command = plan

  assert {
    condition     = aws_scheduler_schedule.launcher.state == "DISABLED" && aws_scheduler_schedule.launcher.schedule_expression == "rate(1 minute)"
    error_message = "The schedule ships disabled (launcher_enabled = false)."
  }
  assert {
    condition = alltrue([
      aws_lambda_function.launcher.function_name == "conductia-deploy-runner-launch",
      aws_scheduler_schedule.launcher.name == "conductia-deploy-runner-launch",
      aws_iam_role.launcher.name == "conductia-deploy-runner-launch",
      aws_security_group.deploy.name == "conductia-deploy-runner",
      aws_launch_template.deploy.name == "conductia-deploy-runner",
    ])
    error_message = "Names stay outside the CI operator's conductia-ci-runner* scope."
  }
}

run "enabled_with_app_ids" {
  command = plan

  variables {
    launcher_enabled           = true
    github_app_id              = "123456"
    github_app_installation_id = "7890123"
  }

  assert {
    condition     = aws_scheduler_schedule.launcher.state == "ENABLED"
    error_message = "The second apply of O4 enables the schedule."
  }
}

run "enabled_without_app_ids_is_refused" {
  command = plan

  variables {
    launcher_enabled = true
  }

  expect_failures = [aws_scheduler_schedule.launcher]
}

run "an_empty_admin_list_is_refused" {
  command = plan

  variables {
    launcher_admin_arns = []
  }

  expect_failures = [var.launcher_admin_arns]
}

# The guard (design R21) ------------------------------------------------------------------------

run "launcher_guard_is_pinned" {
  command = plan

  assert {
    condition     = aws_iam_policy.launcher_guard.name == "conductia-deploy-launcher-guard" && output.launcher_guard_policy_arn == "arn:aws:iam::123456789012:policy/conductia-deploy-launcher-guard"
    error_message = "One managed guard, conductia-deploy-launcher-guard, output for O16."
  }
  assert {
    condition = { for s in jsondecode(aws_iam_policy.launcher_guard.policy).Statement : s.Sid => s } == {
      LauncherFunction = {
        Sid    = "LauncherFunction"
        Effect = "Deny"
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
        Resource = [
          "arn:aws:lambda:us-east-1:123456789012:function:conductia-deploy-runner-launch",
          "arn:aws:lambda:us-east-1:123456789012:function:conductia-deploy-runner-launch:*",
        ]
      }
      LauncherRoleAndGuard = {
        Sid      = "LauncherRoleAndGuard"
        Effect   = "Deny"
        Action   = "iam:*"
        Resource = ["arn:aws:iam::123456789012:role/conductia-deploy-runner-launch", "arn:aws:iam::123456789012:role/conductia-deploy-runner-scheduler", "arn:aws:iam::123456789012:policy/conductia-deploy-launcher-guard"]
      }
      GuardDetach = {
        Sid       = "GuardDetach"
        Effect    = "Deny"
        Action    = ["iam:DetachRolePolicy", "iam:DetachUserPolicy", "iam:DetachGroupPolicy"]
        Resource  = "*"
        Condition = { ArnEquals = { "iam:PolicyARN" = "arn:aws:iam::123456789012:policy/conductia-deploy-launcher-guard" } }
      }
      AppKmsKey = {
        Sid      = "AppKmsKey"
        Effect   = "Deny"
        Action   = "kms:*"
        Resource = ["arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000", "arn:aws:kms:us-east-1:123456789012:alias/conductia-deploy-runner"]
      }
      AppKeyParameter = {
        Sid      = "AppKeyParameter"
        Effect   = "Deny"
        Action   = ["ssm:GetParameter*", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion"]
        Resource = ["arn:aws:ssm:us-east-1:123456789012:parameter/conductia/deploy-runner/github-app-key", "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/deploy-runner"]
      }
      LauncherSchedule = {
        Sid      = "LauncherSchedule"
        Effect   = "Deny"
        Action   = ["scheduler:UpdateSchedule", "scheduler:DeleteSchedule"]
        Resource = "arn:aws:scheduler:us-east-1:123456789012:schedule/default/conductia-deploy-runner-launch"
      }
      LauncherLogs = {
        Sid    = "LauncherLogs"
        Effect = "Deny"
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
        Resource = [
          "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch",
          "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch:*",
        ]
      }
      AlarmMetrics = {
        Sid       = "AlarmMetrics"
        Effect    = "Deny"
        Action    = "cloudwatch:PutMetricData"
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "Conductia/DeployRunner" } }
      }
      Alarms = {
        Sid      = "Alarms"
        Effect   = "Deny"
        Action   = ["cloudwatch:DeleteAlarms", "cloudwatch:DisableAlarmActions", "cloudwatch:SetAlarmState", "cloudwatch:PutMetricAlarm"]
        Resource = "arn:aws:cloudwatch:us-east-1:123456789012:alarm:conductia-deploy-*"
      }
      AuditRules = {
        Sid      = "AuditRules"
        Effect   = "Deny"
        Action   = ["events:PutRule", "events:DeleteRule", "events:DisableRule", "events:PutTargets", "events:RemoveTargets"]
        Resource = "arn:aws:events:us-east-1:123456789012:rule/conductia-deploy-*"
      }
      AlertTopic = {
        Sid       = "AlertTopic"
        Effect    = "Deny"
        NotAction = "sns:Publish"
        Resource  = ["arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts", "arn:aws:sns:us-east-1:123456789012:conductia-deploy-runner-alerts:*"]
      }
      DeployVmUserData = {
        Sid       = "DeployVmUserData"
        Effect    = "Deny"
        Action    = ["ec2:DescribeInstanceAttribute", "ec2:GetLaunchTemplateData", "ec2:GetConsoleOutput", "ec2:GetConsoleScreenshot"]
        Resource  = "arn:aws:ec2:us-east-1:123456789012:instance/*"
        Condition = { StringEquals = { "ec2:ResourceTag/Component" = "deploy-runner" } }
      }
      DeployVmChanges = {
        Sid    = "DeployVmChanges"
        Effect = "Deny"
        Action = [
          "ec2:ModifyInstanceAttribute", "ec2:ModifyNetworkInterfaceAttribute", "ec2:StopInstances", "ec2:TerminateInstances",
          "ec2:RebootInstances", "ec2:ModifyInstanceMetadataOptions",
          "ec2:AssociateIamInstanceProfile", "ec2:ReplaceIamInstanceProfileAssociation", "ec2:DisassociateIamInstanceProfile",
          "ec2:CreateImage", "ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:AttachVolume", "ec2:DetachVolume",
        ]
        Resource  = ["arn:aws:ec2:us-east-1:123456789012:instance/*", "arn:aws:ec2:us-east-1:123456789012:network-interface/*", "arn:aws:ec2:us-east-1:123456789012:volume/*"]
        Condition = { StringEquals = { "ec2:ResourceTag/Component" = "deploy-runner" } }
      }
      LaunchTemplate = {
        Sid      = "LaunchTemplate"
        Effect   = "Deny"
        Action   = ["ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:DeleteLaunchTemplateVersions"]
        Resource = "arn:aws:ec2:us-east-1:123456789012:launch-template/lt-0123456789abcdef0"
      }
      SecurityGroup = {
        Sid    = "SecurityGroup"
        Effect = "Deny"
        Action = [
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupEgress",
          "ec2:ModifySecurityGroupRules",
          "ec2:DeleteSecurityGroup",
        ]
        Resource = "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0"
      }
      DeployTagForge = {
        Sid       = "DeployTagForge"
        Effect    = "Deny"
        Action    = ["ec2:CreateTags", "ec2:RunInstances"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestTag/Component" = "deploy-runner" } }
      }
      RunnerIdForge = {
        Sid       = "RunnerIdForge"
        Effect    = "Deny"
        Action    = ["ec2:CreateTags", "ec2:RunInstances"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "aws:TagKeys" = "RunnerId" } }
      }
      DeployRetag = {
        Sid       = "DeployRetag"
        Effect    = "Deny"
        Action    = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource  = "*"
        Condition = { StringEquals = { "ec2:ResourceTag/Component" = "deploy-runner" } }
      }
    }
    error_message = "The guard holds exactly the R21 denies (review 1 #4, #5, #9, #17; round 2 #9), each on the launcher's own ARNs."
  }
  assert {
    condition     = length(aws_iam_policy.launcher_guard.policy) <= 6144
    error_message = "A managed policy holds at most 6,144 characters."
  }
}

run "launcher_guard_attached_to_exactly_the_fleet_roles" {
  command = plan

  assert {
    condition = (
      toset(keys(aws_iam_role_policy_attachment.launcher_guard)) == toset(["conductia-ci-runner-instance", "conductia-ci-runner-wake", "conductia-ci-runner-scheduler"]) &&
      alltrue([for k, a in aws_iam_role_policy_attachment.launcher_guard : a.role == k && a.policy_arn == "arn:aws:iam::123456789012:policy/conductia-deploy-launcher-guard"])
    )
    error_message = "The module attaches the guard to the CI fleet's instance, wake and scheduler roles, by name, and to nothing else."
  }
  assert {
    condition = (
      length(regexall("resource\\s+\"aws_iam_role_policy_attachment\"\\s+\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")]))) == 1 &&
      !can(regex("resource\\s+\"(aws_iam_policy_attachment|aws_iam_[a-z_]+_exclusive)\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")]))) &&
      !can(regex("(?m)^\\s*(managed_policy_arns\\s*=|inline_policy\\s*\\{)", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")])))
    )
    error_message = "The guard attachments are the module's only managed-policy attachments, and it declares no exclusive policy list, so it and infra/ci-runner never undo each other."
  }
  assert {
    condition     = aws_iam_role_policy.launcher_guard.role == aws_iam_role.launcher.id && aws_iam_role_policy.launcher_guard.name == "conductia-deploy-runner-launch-guard"
    error_message = "The launcher role carries the guard's variant inline, never the shared guard."
  }
}

run "launcher_guard_variant_keeps_what_the_launcher_calls" {
  command = plan

  # The shared guard denies kms:Decrypt on the App key; the launcher's variant does
  # not (review 1, #3). A statement covers an action through Action (exactly, by
  # a trailing-* prefix, or "*") or through a NotAction that does not exclude it.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.launcher_guard.policy).Statement :
      contains(flatten([try(s.Action, [""])]), "kms:*") && contains(flatten([s.Resource]), "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000")
    ])
    error_message = "The shared guard denies kms:Decrypt (kms:*) on the App key."
  }
  assert {
    condition = one([for s in jsondecode(aws_iam_role_policy.launcher_guard.policy).Statement : s if s.Sid == "AppKmsKey"]) == {
      Sid       = "AppKmsKey"
      Effect    = "Deny"
      NotAction = "kms:Decrypt"
      Resource  = ["arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000", "arn:aws:kms:us-east-1:123456789012:alias/conductia-deploy-runner"]
    }
    error_message = "The launcher's variant denies every KMS action on the App key but Decrypt."
  }

  # Every call the launcher makes (lambda/deploy.mjs, and Lambda's own log writes
  # with the role) on every resource it touches. No Deny in the variant may cover
  # one, conditions ignored, so a conditioned deny counts as covering: stricter.
  assert {
    condition = alltrue(flatten([
      for need in [
        { action = "logs:CreateLogStream", resources = ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch:log-stream:2026/10/22/[$LATEST]0123456789abcdef"] },
        { action = "logs:PutLogEvents", resources = ["arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch:log-stream:2026/10/22/[$LATEST]0123456789abcdef"] },
        { action = "ssm:GetParameter", resources = ["arn:aws:ssm:us-east-1:123456789012:parameter/conductia/deploy-runner/github-app-key"] },
        { action = "kms:Decrypt", resources = ["arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000"] },
        { action = "ec2:RunInstances", resources = [
          "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0",
          "arn:aws:ec2:us-east-1:123456789012:volume/vol-0123456789abcdef0",
          "arn:aws:ec2:us-east-1:123456789012:network-interface/eni-0123456789abcdef0",
          "arn:aws:ec2:us-east-1:123456789012:launch-template/lt-0123456789abcdef0",
          "arn:aws:ec2:us-east-1::image/ami-0123456789abcdef0",
          "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123456789abcdef0",
          "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0",
        ] },
        { action = "ec2:CreateTags", resources = [
          "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0",
          "arn:aws:ec2:us-east-1:123456789012:volume/vol-0123456789abcdef0",
          "arn:aws:ec2:us-east-1:123456789012:network-interface/eni-0123456789abcdef0",
        ] },
        { action = "ec2:TerminateInstances", resources = ["arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0"] },
        { action = "ec2:DescribeInstances", resources = ["*"] },
        ] : [
        for s in jsondecode(aws_iam_role_policy.launcher_guard.policy).Statement : !(
          (
            length(setintersection(
              toset(flatten([try(s.Action, [""])])),
              toset(concat(["*", need.action], [for i in range(length(split(":", need.action)[1]) + 1) : "${split(":", need.action)[0]}:${substr(split(":", need.action)[1], 0, i)}*"])),
            )) > 0 ||
            (can(s.NotAction) && length(setintersection(
              toset(flatten([try(s.NotAction, [""])])),
              toset(concat(["*", need.action], [for i in range(length(split(":", need.action)[1]) + 1) : "${split(":", need.action)[0]}:${substr(split(":", need.action)[1], 0, i)}*"])),
            )) == 0)
          ) &&
          anytrue([
            for r in flatten([s.Resource]) : anytrue([
              for t in need.resources : r == "*" || r == t || (endswith(r, "*") && startswith(t, trimsuffix(r, "*")))
            ])
          ])
        )
      ]
    ]))
    error_message = "The launcher's variant denies none of the calls the launcher makes: its log streams, the App key read and decrypt, launch, tag on create, terminate and describe."
  }

  # And the shared guard denies each call the variant leaves to the launcher.
  assert {
    condition = alltrue([
      for need in [
        { action = "logs:CreateLogStream", resource = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch:log-stream:x" },
        { action = "logs:PutLogEvents", resource = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-deploy-runner-launch:log-stream:x" },
        { action = "ssm:GetParameter", resource = "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/deploy-runner/github-app-key" },
        { action = "ec2:TerminateInstances", resource = "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0" },
        { action = "ec2:RunInstances", resource = "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0" },
        { action = "ec2:CreateTags", resource = "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0" },
        ] : anytrue([
          for s in jsondecode(aws_iam_policy.launcher_guard.policy).Statement :
          length(setintersection(
            toset(flatten([try(s.Action, [""])])),
            toset(concat(["*", need.action], [for i in range(length(split(":", need.action)[1]) + 1) : "${split(":", need.action)[0]}:${substr(split(":", need.action)[1], 0, i)}*"])),
          )) > 0 && anytrue([for r in flatten([s.Resource]) : r == "*" || r == need.resource || (endswith(r, "*") && startswith(need.resource, trimsuffix(r, "*")))])
      ])
    ])
    error_message = "Every principal carrying the shared guard is denied what only the launcher may do: write its log, read the App key, terminate, launch or tag a deploy VM."
  }

  # The rest of the variant is the guard, unchanged or trimmed.
  assert {
    condition = (
      toset([for s in jsondecode(aws_iam_role_policy.launcher_guard.policy).Statement : s.Sid]) ==
      setsubtract(toset([for s in jsondecode(aws_iam_policy.launcher_guard.policy).Statement : s.Sid]), toset(["DeployTagForge", "RunnerIdForge", "DeployRetag"])) &&
      alltrue([
        for s in jsondecode(aws_iam_role_policy.launcher_guard.policy).Statement :
        s == one([for g in jsondecode(aws_iam_policy.launcher_guard.policy).Statement : g if g.Sid == s.Sid])
        if !contains(["AppKmsKey", "AppKeyParameter", "LauncherLogs", "DeployVmChanges"], s.Sid)
      ])
    )
    error_message = "The variant is the guard without its three tag denies; only the KMS, parameter, log and VM-change statements differ."
  }
  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.launcher_guard.policy).Statement : s.Action if s.Sid == "AppKeyParameter"]) == [
        "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion",
      ] &&
      one([for s in jsondecode(aws_iam_role_policy.launcher_guard.policy).Statement : s.Action if s.Sid == "LauncherLogs"]) == [
        "logs:PutRetentionPolicy", "logs:DeleteLogGroup", "logs:DeleteLogStream", "logs:PutMetricFilter", "logs:DeleteMetricFilter", "logs:AssociateKmsKey", "logs:DisassociateKmsKey",
      ] &&
      one([for s in jsondecode(aws_iam_role_policy.launcher_guard.policy).Statement : s.Action if s.Sid == "DeployVmChanges"]) == [
        "ec2:ModifyInstanceAttribute", "ec2:ModifyNetworkInterfaceAttribute", "ec2:StopInstances",
        "ec2:RebootInstances", "ec2:ModifyInstanceMetadataOptions",
        "ec2:AssociateIamInstanceProfile", "ec2:ReplaceIamInstanceProfileAssociation", "ec2:DisassociateIamInstanceProfile",
        "ec2:CreateImage", "ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:AttachVolume", "ec2:DetachVolume",
      ]
    )
    error_message = "The variant keeps the guard's parameter, log and VM-change denies except GetParameter, its own log streams and TerminateInstances."
  }
  assert {
    condition     = length(aws_iam_role_policy.launcher.policy) + length(aws_iam_role_policy.launcher_guard.policy) <= 10240
    error_message = "A role's inline policies hold at most 10,240 characters together."
  }
}
