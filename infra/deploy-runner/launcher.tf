# The launcher (design R7): every minute it lists the repository's queued jobs
# that could take a deploy runner, admits each against the allowlist and checks
# its commit is on its branch, and, only if none is refused, mints one JIT runner
# in the conductia-deploy group per admitted job and launches a fresh VM for it
# from the pinned launch template (lambda/deploy.mjs, lambda/deploy-plan.mjs).
# It also reports runners it never minted, deletes runners whose VM is gone, and
# retires idle, over-cap and hard-capped VMs, deleting the runner before it
# terminates an idle VM (design R23, R26).
#
# The VM has no instance profile: it needs no AWS API, so a job that lands on it
# gets no AWS credential, and nothing it leaves survives the VM (design R4, R5).

# Launch template -----------------------------------------------------------------------------

# Everything a deploy VM is made of except its user data, which carries the
# runner's JIT config and comes from the launcher. The launcher always passes the
# version tofu pins here (LAUNCH_TEMPLATE_VERSION), never $Default or $Latest, and
# its role may launch only from this template with this AMI, subnet and group.
resource "aws_launch_template" "deploy" {
  name                                 = local.name
  description                          = "Deploy runner VM (ADR-0028): no instance profile, no ingress, terminates on shutdown"
  image_id                             = var.ami_id
  instance_type                        = local.instance_type
  instance_initiated_shutdown_behavior = "terminate"
  update_default_version               = true

  network_interfaces {
    device_index                = 0
    subnet_id                   = data.aws_subnet.public.id
    security_groups             = [aws_security_group.deploy.id]
    associate_public_ip_address = true
    delete_on_termination       = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  block_device_mappings {
    device_name = "/dev/sda1"

    ebs {
      volume_type           = "gp3"
      volume_size           = local.volume_gb
      encrypted             = true
      delete_on_termination = true
    }
  }

  # The launcher repeats Component and adds RunnerId on each launch; its role may
  # launch only resources that carry Component = deploy-runner.
  dynamic "tag_specifications" {
    for_each = ["instance", "volume", "network-interface"]

    content {
      resource_type = tag_specifications.value
      tags          = merge(local.tags, { Name = local.name })
    }
  }
}

# Logs -----------------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "launcher" {
  name              = "/aws/lambda/${local.launcher_name}"
  retention_in_days = var.log_retention_days
}

# Role -----------------------------------------------------------------------------------------

resource "aws_iam_role" "launcher" {
  name        = local.launcher_name
  description = "Deploy runner launcher: mint JIT runners, launch deploy VMs from the pinned template"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LambdaOnly"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id } }
    }]
  })
}

locals {
  arn_prefix = "arn:aws:ec2:${var.region}:${var.aws_account_id}"
  # Every resource RunInstances creates is tagged, and the role checks the tag.
  tagged_types = ["instance", "volume", "network-interface"]

  # Following AWS's launch-template policy examples (design R7, review 1 #13).
  # RunTemplate carries no condition: the template is not a resource sourced from
  # itself, so ec2:IsLaunchTemplateResource is absent for it and a condition there
  # would deny every launch (round 2, #7). The AMI, subnet and group may be used
  # only as the template supplies them. KMS is not here: the key policy names the
  # role directly (kms.tf).
  launcher_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.launcher.arn}:*"
      },
      {
        Sid      = "ReadAppKey"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = local.app_key_parameter_arn
      },
      {
        Sid      = "RunFromTemplate"
        Effect   = "Allow"
        Action   = "ec2:RunInstances"
        Resource = "${local.arn_prefix}:instance/*"
        # The template's type only (audit V20): a launch call may override the
        # instance type, and the template pin alone would not stop that.
        Condition = {
          ArnEquals    = { "ec2:LaunchTemplate" = aws_launch_template.deploy.arn }
          StringEquals = { "aws:RequestTag/Component" = local.component, "ec2:InstanceType" = local.instance_type }
        }
      },
      {
        Sid       = "RunTaggedParts"
        Effect    = "Allow"
        Action    = "ec2:RunInstances"
        Resource  = ["${local.arn_prefix}:volume/*", "${local.arn_prefix}:network-interface/*"]
        Condition = { StringEquals = { "aws:RequestTag/Component" = local.component } }
      },
      {
        Sid      = "RunTemplate"
        Effect   = "Allow"
        Action   = "ec2:RunInstances"
        Resource = aws_launch_template.deploy.arn
      },
      {
        Sid    = "RunPinnedInputs"
        Effect = "Allow"
        Action = "ec2:RunInstances"
        Resource = [
          "arn:aws:ec2:${var.region}::image/${var.ami_id}",
          data.aws_subnet.public.arn,
          aws_security_group.deploy.arn,
        ]
        Condition = { Bool = { "ec2:IsLaunchTemplateResource" = "true" } }
      },
      {
        Sid       = "TagOnCreate"
        Effect    = "Allow"
        Action    = "ec2:CreateTags"
        Resource  = [for t in local.tagged_types : "${local.arn_prefix}:${t}/*"]
        Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances" } }
      },
      {
        Sid      = "Describe"
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
      },
      # The reaper (design R26, round 2 #9): only VMs carrying the deploy tag AND
      # launched from this template. AWS sets aws:ec2launchtemplate:id on every
      # launch from a template, and nobody can set an aws: tag by hand, so a
      # Component tag alone never makes an instance terminable. The launcher
      # checks the same three tags itself before every terminate (trusted()).
      {
        Sid      = "ReapOwn"
        Effect   = "Allow"
        Action   = "ec2:TerminateInstances"
        Resource = "${local.arn_prefix}:instance/*"
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Component"                = local.component
            "ec2:ResourceTag/aws:ec2launchtemplate:id" = aws_launch_template.deploy.id
          }
        }
      },
    ]
  }
}

resource "aws_iam_role_policy" "launcher" {
  name   = local.launcher_name
  role   = aws_iam_role.launcher.id
  policy = jsonencode(local.launcher_policy)
}

# The guard's variant for the launcher itself (guard.tf, design R21): a
# compromised launcher still cannot rewrite itself, its role, its template or
# its key. It keeps only what it calls: its own log streams, ssm:GetParameter
# and kms:Decrypt on the App key, and TerminateInstances on its own VMs. The
# shared guard is never attached here: its tag denies would stop every launch.
resource "aws_iam_role_policy" "launcher_guard" {
  name   = "${local.launcher_name}-guard"
  role   = aws_iam_role.launcher.id
  policy = jsonencode(local.launcher_guard_variant)
}

# Function -------------------------------------------------------------------------------------

# The handler, its pure planning module and the rendered boot script. Tests and
# fixtures stay out of the zip.
data "archive_file" "launcher" {
  type        = "zip"
  output_path = "${path.module}/.build/deploy.zip"

  source {
    content  = file("${path.module}/lambda/deploy.mjs")
    filename = "deploy.mjs"
  }
  source {
    content  = file("${path.module}/lambda/deploy-plan.mjs")
    filename = "deploy-plan.mjs"
  }
  source {
    content  = local.user_data_script
    filename = "user-data.sh"
  }
}

resource "aws_lambda_function" "launcher" {
  function_name    = local.launcher_name
  description      = "Mint a JIT runner in the deploy group for each admitted deploy job, on a fresh VM (ADR-0028)"
  role             = aws_iam_role.launcher.arn
  runtime          = "nodejs22.x"
  handler          = "deploy.handler"
  filename         = data.archive_file.launcher.output_path
  source_code_hash = data.archive_file.launcher.output_base64sha256
  # Below the one-minute schedule. That alone does not stop two ticks
  # overlapping: Scheduler invokes asynchronously, and Lambda retries a failed
  # async invocation twice by default, so a retried tick could run beside the
  # next scheduled one and both mint for the same job (audit V2). One
  # concurrent execution and no async retries (event invoke config below) do.
  timeout                        = 50
  memory_size                    = 256
  reserved_concurrent_executions = 1

  # JSON log format, and each record logged as one object argument, so a metric
  # filter can match $.message.event (review 1, #7).
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.launcher.name
  }

  environment {
    variables = {
      REPO                       = var.github_repo
      GITHUB_APP_ID              = var.github_app_id
      GITHUB_APP_INSTALLATION_ID = var.github_app_installation_id
      APP_KEY_PARAM              = local.app_key_parameter
      GROUP_NAME                 = var.deploy_runner_group
      RUNNER_LABELS              = join(",", var.runner_labels)
      ALLOWLIST                  = jsonencode(var.deploy_allowlist)
      TEMPLATE_ID                = aws_launch_template.deploy.id
      LAUNCH_TEMPLATE_VERSION    = tostring(aws_launch_template.deploy.latest_version)
      CAP                        = tostring(local.cap)
    }
  }

  depends_on = [aws_cloudwatch_log_group.launcher, aws_iam_role_policy.launcher, aws_iam_role_policy.launcher_guard]
}

# A failed or timed-out tick is never retried: the next scheduled tick reads
# everything afresh a minute later. An invocation throttled by the reserved
# concurrency of 1 (the previous tick still running) is dropped after 60 s
# rather than queued for up to six hours, so it never runs beside a later tick
# either. The guard denies changing or deleting this configuration.
resource "aws_lambda_function_event_invoke_config" "launcher" {
  function_name                = aws_lambda_function.launcher.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}

# Schedule -------------------------------------------------------------------------------------

resource "aws_iam_role" "scheduler" {
  name        = "${local.name}-scheduler"
  description = "EventBridge Scheduler: invoke the deploy runner launcher"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SchedulerOfThisAccountOnly"
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "${local.name}-scheduler"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeLauncher"
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.launcher.arn
    }]
  })
}

# Disabled until the second apply of O4 sets launcher_enabled with the App ids.
resource "aws_scheduler_schedule" "launcher" {
  name                         = local.launcher_name
  group_name                   = "default"
  schedule_expression          = "rate(1 minute)"
  schedule_expression_timezone = "UTC"
  state                        = var.launcher_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.launcher.arn
    role_arn = aws_iam_role.scheduler.arn

    # Scheduler's own retries, of an invoke it could not deliver. Lambda's
    # retries of a failed tick are off in the event invoke config above.
    retry_policy {
      maximum_event_age_in_seconds = 60
      maximum_retry_attempts       = 0
    }
  }

  lifecycle {
    precondition {
      condition     = !var.launcher_enabled || (var.github_app_id != "" && var.github_app_installation_id != "")
      error_message = "launcher_enabled needs github_app_id and github_app_installation_id (O3, then the second apply of O4)."
    }
  }
}
