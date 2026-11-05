# Two roles (design R7).
#
# The task role is the identity GCP federation trusts: the #342 kit's pool admits
# only assertion.arn starting with
# arn:aws:sts::<account>:assumed-role/<task_role_name>/ (trailing slash). It holds
# no permission at all (GetCallerIdentity needs none; A4), and only ECS tasks of
# this account and region may assume it.
#
# The execution role is ECS's, not the worker's: it pulls the image, writes the
# log stream and injects the named secrets and the two probe parameters.
#
# Both trusts take the account-scoped form of "Amazon ECS task IAM role" in the
# ECS developer guide (checked 2026-10-04,
# https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html):
# aws:SourceAccount plus aws:SourceArn
# arn:aws:ecs:<region>:<account>:*. A cluster-specific aws:SourceArn "is not
# currently supported" there, so the cluster restriction lives on RunTask and
# UpdateService (deploy_role.tf), in an account dedicated to the worker.
# The execution role shares the service principal and takes the same form.

locals {
  ecs_trust_condition = {
    StringEquals = { "aws:SourceAccount" = var.aws_account_id }
    ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.region}:${var.aws_account_id}:*" }
  }
}

resource "aws_iam_role" "task" {
  name        = var.task_role_name
  path        = "/"
  description = "Discovery worker task identity, trusted by Google workload identity federation; no permissions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EcsTasksOfThisAccountAndRegionOnly"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = local.ecs_trust_condition
    }]
  })
}

resource "aws_iam_role" "execution" {
  name        = "${local.name}-exec"
  path        = "/"
  description = "ECS execution role for the discovery worker: image pull, logs, named secrets and probe parameters"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EcsTasksOfThisAccountAndRegionOnly"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = local.ecs_trust_condition
    }]
  })
}

resource "aws_iam_role_policy" "execution" {
  name = "discovery-worker-execution"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # No resource-level form exists for this action.
        Sid      = "EcrAuthorizationToken"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        # The worker image, and the GuardDuty runtime agent that automated agent
        # management adds as a sidecar to every task (detection.tf, design R11).
        Sid      = "EcrPullTheWorkerImageAndTheGuardDutyAgent"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = [aws_ecr_repository.worker.arn, local.guardduty_agent_repository_arn]
      },
      {
        Sid      = "WriteTheWorkerLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.worker.arn}:*"]
      },
      {
        Sid      = "ReadTheNamedSecrets"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = local.readable_secret_arns
      },
      {
        Sid      = "ReadTheTwoProbeParameters"
        Effect   = "Allow"
        Action   = "ssm:GetParameters"
        Resource = values(local.probe_parameter_arns)
      },
      {
        Sid      = "DecryptWithTheWorkerKey"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = [aws_kms_key.worker.arn]
      },
      {
        # A caller writing to a KMS-encrypted log group needs the key through
        # CloudWatch Logs ("Encrypt log data in CloudWatch Logs using AWS KMS",
        # checked 2026-10-04,
        # https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html):
        # only through Logs, never directly.
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

  lifecycle {
    precondition {
      condition     = local.guardduty_agent_repository_arn != null
      error_message = "No GuardDuty Fargate agent repository is known for this region: set guardduty_agent_repository_arn from the GuardDuty user guide's table."
    }
  }
}
