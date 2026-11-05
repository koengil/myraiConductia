# Three roles, all under /ci-runner/ (the operator policy's IAM scope).
#
#   instance:  the runner host. SSM Session Manager, the CloudWatch agent, and a
#              read of the registration-token parameter only. It has no EC2
#              permission: an idle host stops itself with an OS shutdown
#              (instance_initiated_shutdown_behavior = "stop").
#   wake:      the wake function. Reads the PAT, keeps the registration token
#              fresh, lists runner instances and starts only those tagged
#              Component=ci-runner.
#   scheduler: EventBridge Scheduler's identity to invoke the wake function.
#
# Jobs run on the host with docker-group (root-equivalent) access, so anything
# the instance role can read, any job can read. The PAT therefore never reaches
# a host: the role reads only the registration token, which expires within an
# hour and can do nothing but add a runner to this repository.

locals {
  # Both parameters are SecureStrings under the AWS-managed aws/ssm key; use the
  # key only through SSM. The instance role only decrypts.
  kms_via_ssm = {
    Sid       = "DecryptThroughSsmOnly"
    Effect    = "Allow"
    Action    = "kms:Decrypt"
    Resource  = "arn:aws:kms:${var.region}:${var.aws_account_id}:key/*"
    Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } }
  }
}

resource "aws_iam_role" "instance" {
  name        = "${local.name}-instance"
  path        = local.iam_path
  description = "CI runner host: SSM, CloudWatch agent, PAT read"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "Ec2Only"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "instance_cloudwatch" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadRegistrationToken"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = local.token_parameter_arn
      },
      # AmazonSSMManagedInstanceCore allows ssm:GetParameter(s) on "*", and jobs
      # are root-equivalent on the host (docker group), so without this deny
      # any job could read every parameter in the account, the PAT included.
      {
        Sid         = "DenyEveryOtherParameter"
        Effect      = "Deny"
        Action      = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"]
        NotResource = local.token_parameter_arn
      },
      local.kms_via_ssm,
    ]
  })
}

resource "aws_iam_instance_profile" "runner" {
  name = local.name
  path = local.iam_path
  role = aws_iam_role.instance.name
}

resource "aws_iam_role" "wake" {
  name        = local.wake_name
  path        = local.iam_path
  description = "CI runner wake function"

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

resource "aws_iam_role_policy" "wake" {
  name = local.wake_name
  role = aws_iam_role.wake.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.wake.arn}:*"
      },
      {
        Sid      = "ReadPat"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = local.pat_parameter_arn
      },
      {
        Sid      = "MaintainRegistrationToken"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter", "ssm:AddTagsToResource"]
        Resource = local.token_parameter_arn
      },
      merge(local.kms_via_ssm, { Sid = "EncryptDecryptThroughSsmOnly", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"] }),
      {
        Sid      = "ListInstances"
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
      },
      {
        Sid       = "StartRunnerInstancesOnly"
        Effect    = "Allow"
        Action    = "ec2:StartInstances"
        Resource  = "arn:aws:ec2:${var.region}:${var.aws_account_id}:instance/*"
        Condition = { StringEquals = { "ec2:ResourceTag/Component" = "ci-runner" } }
      },
    ]
  })
}

resource "aws_iam_role" "scheduler" {
  name        = "${local.name}-scheduler"
  path        = local.iam_path
  description = "EventBridge Scheduler: invoke the CI runner wake function"

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
      Sid      = "InvokeWake"
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.wake.arn
    }]
  })
}
