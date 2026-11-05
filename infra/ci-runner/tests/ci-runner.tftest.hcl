# Offline plan tests for infra/ci-runner. The AWS provider is a mock (no
# account, no credentials, no network call); the archive provider is mocked so
# no zip is written. Run by scripts/infra/validate.sh.

mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = {
      value = "ami-0123456789abcdef0"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/ci-runner/mock"
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:conductia-ci-runner-wake"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/conductia-ci-runner-wake"
    }
  }
}

mock_provider "archive" {}

variables {
  aws_account_id = "123456789012"
}

run "defaults_plan_the_fleet_inside_the_operator_scope" {
  command = plan

  assert {
    condition     = length(aws_instance.runner) == sum([for c in var.runner_classes : c.count]) && toset(keys(aws_instance.runner)) == toset(["heavy-1", "heavy-2", "burst-1", "burst-2", "light-1", "light-2"])
    error_message = "One instance per (class, index): 2 heavy + 2 burst + 2 light."
  }
  assert {
    condition = alltrue([
      for k, i in aws_instance.runner : i.tags.IdleMinutes == (startswith(k, "burst-") ? "10" : "15")
    ])
    error_message = "Each instance carries its class's idle window as tag IdleMinutes: base 15, burst 10."
  }
  assert {
    condition     = alltrue([for i in aws_instance.runner : i.metadata_options[0].instance_metadata_tags == "enabled"])
    error_message = "Instance-metadata tags are on, so idle-stop.sh can read IdleMinutes."
  }
  assert {
    condition = alltrue([
      strcontains(base64decode(regex("path: /opt/ci-runner/idle-stop.sh\\n.*\\n.*\\n    content: ([A-Za-z0-9+/=]+)", aws_instance.runner["burst-1"].user_data)[0]), "default_minutes=10"),
      strcontains(base64decode(regex("path: /opt/ci-runner/idle-stop.sh\\n.*\\n.*\\n    content: ([A-Za-z0-9+/=]+)", aws_instance.runner["light-1"].user_data)[0]), "default_minutes=15"),
    ])
    error_message = "The idle-stop fallback is the class's idle_minutes."
  }
  assert {
    condition     = aws_lambda_function.wake.environment[0].variables.HEAVY_CLASSES == "burst,heavy" && aws_lambda_function.wake.environment[0].variables.BURST_CLASSES == "burst"
    error_message = "Burst runners are heavy-capable and started last."
  }
  assert {
    condition     = local.allowed_account_ids == ["123456789012"]
    error_message = "The provider is pinned to the given account only."
  }
  assert {
    condition = alltrue([
      for r in [aws_iam_role.instance, aws_iam_role.wake, aws_iam_role.scheduler] : r.path == "/ci-runner/"
    ]) && aws_iam_instance_profile.runner.path == "/ci-runner/"
    error_message = "Every role and the instance profile live under /ci-runner/."
  }
  assert {
    condition     = length(aws_security_group.runner.ingress) == 0 && length(aws_default_security_group.runner.ingress) == 0 && length(aws_default_security_group.runner.egress) == 0
    error_message = "No ingress on the runner group; the default group is empty."
  }
  assert {
    condition = alltrue([
      for i in aws_instance.runner :
      i.metadata_options[0].http_tokens == "required" && i.metadata_options[0].http_put_response_hop_limit == 1 &&
      i.root_block_device[0].encrypted && i.root_block_device[0].volume_type == "gp3" &&
      i.instance_initiated_shutdown_behavior == "stop"
    ])
    error_message = "IMDSv2 hop 1, encrypted gp3 root, stop on shutdown."
  }
  assert {
    condition     = aws_instance.runner["heavy-1"].instance_type == "m6a.xlarge" && aws_instance.runner["light-2"].tags.Name == "conductia-ci-runner-light-2" && aws_instance.runner["light-2"].tags.RunnerClass == "light"
    error_message = "Instance names, classes and types follow runner_classes."
  }
  assert {
    condition     = strcontains(aws_instance.runner["heavy-1"].user_data, "RUNNER_LABELS=conductia-ci-heavy,conductia-ci-light")
    error_message = "Heavy runners carry both labels."
  }
  assert {
    condition     = alltrue([for i in aws_instance.runner : strcontains(i.user_data, "net.ipv4.ip_local_reserved_ports = 3000,4310-4311,54320-54329")])
    error_message = "Every host reserves the job ports from ephemeral allocation."
  }
  assert {
    condition = alltrue([
      aws_lambda_function.wake.function_name == "conductia-ci-runner-wake",
      aws_scheduler_schedule.wake.name == "conductia-ci-runner-wake",
      aws_scheduler_schedule.wake.state == "ENABLED",
      aws_cloudwatch_log_group.runner.name == "/conductia/ci-runner",
      aws_cloudwatch_log_group.wake.name == "/aws/lambda/conductia-ci-runner-wake",
    ])
    error_message = "Lambda, schedule and log-group names fit the operator policy."
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.wake.policy).Statement : s.Condition if s.Sid == "StartRunnerInstancesOnly"
    ]) == { StringEquals = { "ec2:ResourceTag/Component" = "ci-runner" } }
    error_message = "The wake function starts only Component=ci-runner instances."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.instance.policy, "ec2:")
    error_message = "The instance role has no EC2 permission."
  }
  assert {
    condition = (
      !strcontains(aws_iam_role_policy.instance.policy, "github-pat") &&
      one([for s in jsondecode(aws_iam_role_policy.instance.policy).Statement : s.Resource if s.Sid == "ReadRegistrationToken"]) ==
      "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/ci-runner/registration-token"
    )
    error_message = "A runner host reads only the registration token, never the PAT."
  }
  assert {
    condition = (
      one([for s in jsondecode(aws_iam_role_policy.wake.policy).Statement : s.Resource if s.Sid == "ReadPat"]) ==
      "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/ci-runner/github-pat" &&
      contains(one([for s in jsondecode(aws_iam_role_policy.wake.policy).Statement : s.Action if s.Sid == "MaintainRegistrationToken"]), "ssm:PutParameter")
    )
    error_message = "Only the wake function reads the PAT, and it writes the registration token."
  }
}

run "wake_disabled_pauses_the_schedule" {
  command = plan

  variables {
    wake_enabled = false
  }

  assert {
    condition     = aws_scheduler_schedule.wake.state == "DISABLED"
    error_message = "wake_enabled = false disables the schedule."
  }
}

run "a_pinned_ami_skips_the_ssm_lookup" {
  command = plan

  variables {
    ami_id = "ami-0fedcba9876543210"
  }

  assert {
    condition     = length(data.aws_ssm_parameter.ubuntu) == 0 && aws_instance.runner["light-1"].ami == "ami-0fedcba9876543210"
    error_message = "ami_id pins the AMI."
  }
}

run "idle_minutes_of_one_is_refused" {
  command = plan

  variables {
    runner_classes = {
      light = { count = 1, instance_type = "m6a.large", labels = ["conductia-ci-light"], volume_gb = 60, idle_minutes = 1 }
    }
  }

  expect_failures = [var.runner_classes]
}

run "idle_minutes_of_300_is_refused" {
  command = plan

  variables {
    runner_classes = {
      light = { count = 1, instance_type = "m6a.large", labels = ["conductia-ci-light"], volume_gb = 60, idle_minutes = 300 }
    }
  }

  expect_failures = [var.runner_classes]
}

run "a_label_outside_conductia_ci_is_refused" {
  command = plan

  variables {
    runner_classes = {
      light = { count = 1, instance_type = "m6a.large", labels = ["ubuntu-latest"], volume_gb = 60, idle_minutes = 15 }
    }
  }

  expect_failures = [var.runner_classes]
}

# infra/deploy-runner attaches its launcher guard (an explicit Deny, design R21)
# to the three roles below by name. The Deny holds whatever else they are given;
# this run pins that the fleet holds no Allow the guard is there to stop, so the
# guard is defence in depth rather than the only line. The mock provider cannot
# read a managed policy, so the two AWS managed attachments are pinned by name
# (their content: research §3, they grant no lambda: or iam: action).
run "fleet_holds_no_allow_the_launcher_guard_denies" {
  command = plan

  assert {
    condition = (
      aws_iam_role.instance.name == "conductia-ci-runner-instance" &&
      aws_iam_role.wake.name == "conductia-ci-runner-wake" &&
      aws_iam_role.scheduler.name == "conductia-ci-runner-scheduler"
    )
    error_message = "infra/deploy-runner (guard.tf) attaches the guard by these three role names: rename one there too."
  }
  assert {
    condition = (
      length(regexall("resource\\s+\"aws_iam_role_policy\"\\s+\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")]))) == 3 &&
      length(regexall("resource\\s+\"aws_iam_role_policy_attachment\"\\s+\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")]))) == 2 &&
      !can(regex("resource\\s+\"(aws_iam_policy|aws_iam_policy_attachment|aws_iam_[a-z_]+_exclusive)\"", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")]))) &&
      !can(regex("(?m)^\\s*(managed_policy_arns\\s*=|inline_policy\\s*\\{)", join("\n", [for f in fileset(path.module, "*.tf") : file("${path.module}/${f}")])))
    )
    error_message = "The fleet's IAM is three inline policies and two managed attachments, with no exclusive policy list: an exclusive list would detach the deploy module's guard on the next apply."
  }
  assert {
    condition = (
      aws_iam_role_policy_attachment.instance_ssm.role == "conductia-ci-runner-instance" &&
      aws_iam_role_policy_attachment.instance_ssm.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" &&
      aws_iam_role_policy_attachment.instance_cloudwatch.role == "conductia-ci-runner-instance" &&
      aws_iam_role_policy_attachment.instance_cloudwatch.policy_arn == "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
    )
    error_message = "The fleet's managed attachments are exactly AmazonSSMManagedInstanceCore and CloudWatchAgentServerPolicy, both on the instance role."
  }
  assert {
    condition = alltrue(flatten([
      for p in [aws_iam_role_policy.instance.policy, aws_iam_role_policy.wake.policy, aws_iam_role_policy.scheduler.policy] : [
        for s in jsondecode(p).Statement : (
          !can(s.NotAction) && !can(s.NotResource) &&
          alltrue([for a in flatten([s.Action]) : !strcontains(a, "*") && !startswith(a, "iam:")])
        ) if s.Effect == "Allow"
      ]
    ]))
    error_message = "No fleet, wake or scheduler Allow names an iam: action, a wildcard action, a NotAction or a NotResource."
  }
  assert {
    condition = [
      for s in flatten([for p in [aws_iam_role_policy.instance.policy, aws_iam_role_policy.wake.policy, aws_iam_role_policy.scheduler.policy] : jsondecode(p).Statement]) : s
      if s.Effect == "Allow" && anytrue([for a in flatten([s.Action]) : startswith(a, "lambda:")])
      ] == [{
        Sid      = "InvokeWake"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = "arn:aws:lambda:us-east-1:123456789012:function:conductia-ci-runner-wake"
    }]
    error_message = "The only lambda: Allow is the scheduler invoking the wake function: nothing in the fleet can change a function."
  }
  assert {
    condition = alltrue([
      for s in flatten([for p in [aws_iam_role_policy.instance.policy, aws_iam_role_policy.wake.policy, aws_iam_role_policy.scheduler.policy] : jsondecode(p).Statement]) :
      alltrue([for a in flatten([s.Action]) : contains(["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"], a)]) &&
      s.Condition == { StringEquals = { "kms:ViaService" = "ssm.us-east-1.amazonaws.com" } }
      if s.Effect == "Allow" && anytrue([for a in flatten([s.Action]) : startswith(a, "kms:")])
    ])
    error_message = "The fleet's only kms: Allows are Decrypt, Encrypt and GenerateDataKey through SSM, for its own SecureStrings. They cannot reach the App key: its key policy has no account-root statement, so no IAM Allow applies to it."
  }
  assert {
    condition = alltrue([
      for p in [aws_iam_role_policy.instance.policy, aws_iam_role_policy.wake.policy, aws_iam_role_policy.scheduler.policy] :
      !strcontains(p, "deploy-runner") && !strcontains(p, "conductia-deploy") && !strcontains(p, "github-app-key")
    ])
    error_message = "No fleet, wake or scheduler statement names the launcher, its role, key, App key parameter, logs or alarms."
  }
  assert {
    condition = alltrue(flatten([
      for s in flatten([for p in [aws_iam_role_policy.instance.policy, aws_iam_role_policy.wake.policy, aws_iam_role_policy.scheduler.policy] : jsondecode(p).Statement]) : [
        for r in flatten([s.Resource]) : contains([
          "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/ci-runner/registration-token",
          "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/ci-runner/github-pat",
        ], r)
      ]
      if s.Effect == "Allow" && anytrue([for a in flatten([s.Action]) : startswith(a, "ssm:")])
    ]))
    error_message = "Every fleet, wake or scheduler ssm: Allow names exactly the registration token or the PAT, never a wildcard: none can reach the App key parameter."
  }
  assert {
    condition = alltrue([
      for s in flatten([for p in [aws_iam_role_policy.instance.policy, aws_iam_role_policy.wake.policy, aws_iam_role_policy.scheduler.policy] : jsondecode(p).Statement]) :
      s.Action == "ec2:DescribeInstances"
      if s.Effect == "Allow" && contains(flatten([s.Resource]), "*")
    ])
    error_message = "The only Allow on Resource \"*\" is the wake function's DescribeInstances."
  }
}
