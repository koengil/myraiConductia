# The deploy role (design R8; A4, A16): the owner's identity for the image push,
# the probe, once and estimate runs (and the demo-only classify-propose run while
# propose_gateway_enabled, #460), and the stop levers. It is guarded as what it is. It
# registers no task definition (tofu does, as admin), but a principal that can
# run the probe, once or estimate family with a command override, or scale a service up,
# runs code under the four secrets and the task role, so holding deploy equals
# holding the secrets and the Gmail identity (the runbook's blast radius, signed
# at G0). The classify-propose run adds the model gateway key to that. It reads no log group either: the worker key encrypts them, and deploy
# is denied every kms: action, so the runbook reads logs as admin.
#
# Trust, by the owner's principal type (O1):
#   iam_user: only the named IAM users, with MFA in the last hour.
#   sso:      only the Identity Center permission-set role pattern. A chained
#             AssumeRole from an SSO session does not carry
#             aws:MultiFactorAuthPresent, so the MFA condition would lock the
#             owner out: MFA is enforced in Identity Center instead, and G8
#             records that setting (a documented deviation).
# Either way a session lasts one hour at most, and every assumption pages the
# owner and the CCO (alerts.tf).
#
# The tofu applies run as admin, never as deploy (runbook step 2).

locals {
  deploy_role_name = "${local.name}-deploy"

  deploy_trust_statement = {
    iam_user = {
      Sid       = "NamedIamUsersWithMfa"
      Effect    = "Allow"
      Principal = { AWS = var.deploy_trusted_principal_arns }
      Action    = "sts:AssumeRole"
      Condition = {
        Bool            = { "aws:MultiFactorAuthPresent" = "true" }
        NumericLessThan = { "aws:MultiFactorAuthAge" = "3600" }
      }
    }
    # A role pattern cannot be a Principal, so the account is the principal and
    # the condition names the reserved role (the AWS-documented form).
    sso = {
      Sid       = "IdentityCenterPermissionSetOnly"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
      Action    = "sts:AssumeRole"
      Condition = {
        ArnLike = { "aws:PrincipalArn" = var.deploy_trusted_principal_arns }
      }
    }
  }

  # What each principal type may name. No account root, no bare wildcard, this
  # account only.
  deploy_principal_shape = {
    iam_user = "^arn:aws:iam::${var.aws_account_id}:user/[A-Za-z0-9+=,.@_/-]+$"
    sso      = "^arn:aws:iam::${var.aws_account_id}:role/aws-reserved/sso\\.amazonaws\\.com/([a-z0-9-]+/)?AWSReservedSSO_[A-Za-z0-9+=,.@_-]+_\\*$"
  }

  # The fixed-command families deploy may run. The demo-only classify-propose
  # family (#460) joins only while propose_gateway_enabled, so with the flag off
  # deploy gains nothing.
  deploy_run_task_arns = [
    for family in concat(
      [local.families.probe, local.families.once, local.families.estimate],
      var.propose_gateway_enabled ? [local.families.classify_propose] : [],
    ) : "arn:aws:ecs:${var.region}:${var.aws_account_id}:task-definition/${family}:*"
  ]
  deploy_service_arns = [
    for service in values(local.services) : "arn:aws:ecs:${var.region}:${var.aws_account_id}:service/${local.cluster_name}/${service}"
  ]
}

resource "aws_iam_role" "deploy" {
  name                 = local.deploy_role_name
  path                 = "/"
  description          = "Discovery worker deploy: image push, probe, once and estimate runs (and classify-propose when enabled), stop tasks, scale to zero. Equals the secrets plus the Gmail identity; every use alerts"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.deploy_trust_statement[var.deploy_principal_type]]
  })

  lifecycle {
    precondition {
      condition     = alltrue([for arn in var.deploy_trusted_principal_arns : can(regex(local.deploy_principal_shape[var.deploy_principal_type], arn))])
      error_message = "deploy_trusted_principal_arns must match deploy_principal_type in this account: iam_user takes arn:aws:iam::<account>:user/<name>; sso takes arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/[<region>/]AWSReservedSSO_<set>_*. Never the root or a wildcard principal."
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name = "discovery-worker-deploy"
  role = aws_iam_role.deploy.id

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
        Sid    = "PushToTheWorkerRepository"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:DescribeImages",
          "ecr:DescribeImageScanFindings",
        ]
        Resource = aws_ecr_repository.worker.arn
      },
      {
        # The stop lever (scale to 0) and a forced redeploy after a rotation.
        # The same action can scale a service up: a residual G0 signs, caught by
        # the ecs-operation alert and reverted by the next apply.
        Sid      = "UpdateTheTwoServices"
        Effect   = "Allow"
        Action   = "ecs:UpdateService"
        Resource = local.deploy_service_arns
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.worker.arn }
        }
      },
      {
        # The fixed-command families only: probe, once, estimate, and the
        # demo-only classify-propose run behind propose_gateway_enabled (#460;
        # the Sid keeps its original name). IAM has no condition key for
        # container overrides (checked 2026-10-04): the overrides alert is the
        # control, and G8 tests it once.
        Sid      = "RunTheProbeAndOnceFamilies"
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = local.deploy_run_task_arns
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.worker.arn }
        }
      },
      {
        # Kill-switch lever 2 stops every running task of the cluster, the
        # standalone probe, once, estimate and classify-propose runs included. StopTask is resource-level on
        # the task ARN; ListTasks names a container instance, which a Fargate
        # cluster has none of, so it takes * with the cluster condition (Service
        # Authorization Reference, ECS; checked 2026-10-04,
        # https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerservice.html).
        Sid      = "StopTheClusterTasks"
        Effect   = "Allow"
        Action   = "ecs:StopTask"
        Resource = "arn:aws:ecs:${var.region}:${var.aws_account_id}:task/${local.cluster_name}/*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.worker.arn }
        }
      },
      {
        Sid      = "ListTheClusterTasks"
        Effect   = "Allow"
        Action   = "ecs:ListTasks"
        Resource = "*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.worker.arn }
        }
      },
      {
        # What the runbook's run-task and wait need.
        Sid    = "ReadTheRunsItStarts"
        Effect = "Allow"
        Action = ["ecs:DescribeTasks", "ecs:DescribeServices"]
        Resource = concat(
          ["arn:aws:ecs:${var.region}:${var.aws_account_id}:task/${local.cluster_name}/*"],
          local.deploy_service_arns,
        )
      },
      {
        # No resource-level form exists for this action.
        Sid      = "DescribeTaskDefinitions"
        Effect   = "Allow"
        Action   = "ecs:DescribeTaskDefinition"
        Resource = "*"
      },
      {
        # RunTask passes the task definition's task and execution roles, so both
        # are needed. A taskRoleArn override naming the execution role (which
        # can read the secrets) pages on the ecs-task-overrides rule.
        Sid      = "PassOnlyTheTwoWorkerRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [aws_iam_role.task.arn, aws_iam_role.execution.arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        # Explicit denies win over any allow, here or attached later.
        Sid      = "NeverExec"
        Effect   = "Deny"
        Action   = "ecs:ExecuteCommand"
        Resource = "*"
      },
      {
        Sid    = "NeverChangeIam"
        Effect = "Deny"
        Action = [
          "iam:Create*",
          "iam:Put*",
          "iam:Attach*",
          "iam:Detach*",
          "iam:Update*",
          "iam:Delete*",
          "iam:Add*",
          "iam:Remove*",
          "iam:Tag*",
          "iam:Untag*",
          "iam:Set*",
        ]
        Resource = "*"
      },
      {
        # The owner sets secret values as admin (runbook steps 3, 4 and 8).
        Sid      = "NeverTouchSecrets"
        Effect   = "Deny"
        Action   = "secretsmanager:*"
        Resource = "*"
      },
      {
        # ECR encrypts through the grant it made at repository creation, so a
        # push needs no kms: permission of its own (G8 proves it).
        Sid      = "NeverUseKms"
        Effect   = "Deny"
        Action   = "kms:*"
        Resource = "*"
      },
    ]
  })
}
