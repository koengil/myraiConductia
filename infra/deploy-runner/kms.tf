# The App-key KMS key (design R20). It encrypts one thing: the SSM SecureString
# /conductia/deploy-runner/github-app-key, the launcher GitHub App's private key.
#
# The policy has no account-root statement, so no IAM policy in the account can
# grant use of this key, however broad: the key policy alone governs it. Only the
# launcher role may decrypt, and only through SSM for that parameter. The admins
# manage the key and may put a rotated App key (Encrypt), but cannot read one
# without first rewriting this policy (kms:PutKeyPolicy, which PR C's audit
# rules report).
# Everyone else is denied Decrypt, and grants are denied to all, since a grant
# would bypass the policy. KMS refuses a policy that locks out its caller, and
# this module never sets bypass_policy_lockout_safety_check, so the applying
# principal must be one of var.launcher_admin_arns (O15).

locals {
  kms_via_ssm = "ssm.${var.region}.amazonaws.com"

  app_key_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Admin"
        Effect    = "Allow"
        Principal = { AWS = var.launcher_admin_arns }
        Action = [
          "kms:Describe*",
          "kms:Get*",
          "kms:List*",
          "kms:PutKeyPolicy",
          "kms:UpdateKeyDescription",
          "kms:EnableKey",
          "kms:DisableKey",
          "kms:EnableKeyRotation",
          "kms:DisableKeyRotation",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:CreateAlias",
          "kms:UpdateAlias",
          "kms:DeleteAlias",
          "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion",
        ]
        Resource = "*"
      },
      {
        Sid       = "AdminRotateViaSsm"
        Effect    = "Allow"
        Principal = { AWS = var.launcher_admin_arns }
        Action    = ["kms:Encrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService"                      = local.kms_via_ssm
            "kms:EncryptionContext:PARAMETER_ARN" = local.app_key_parameter_arn
          }
        }
      },
      {
        Sid       = "LauncherDecryptViaSsm"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.launcher.arn }
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService"                      = local.kms_via_ssm
            "kms:EncryptionContext:PARAMETER_ARN" = local.app_key_parameter_arn
          }
        }
      },
      {
        Sid       = "DenyDecryptToOthers"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = ["kms:Decrypt", "kms:ReEncrypt*"]
        Resource  = "*"
        Condition = { ArnNotEquals = { "aws:PrincipalArn" = aws_iam_role.launcher.arn } }
      },
      {
        Sid       = "DenyGrants"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "kms:CreateGrant"
        Resource  = "*"
      },
    ]
  }
}

resource "aws_kms_key" "app_key" {
  description             = "Conductia deploy runner: the launcher GitHub App's private key (SSM ${local.app_key_parameter})"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = jsonencode(local.app_key_policy)
}

resource "aws_kms_alias" "app_key" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.app_key.key_id
}
