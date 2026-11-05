# One customer-managed key for the worker's secrets, probe parameters, log groups
# (the worker's, the flow logs and the Resolver query logs) and image repository,
# with yearly automatic rotation (design R9, R11, R21; A16). The trail has its own
# key (cloudtrail.tf), and the alert topics use none (alerts.tf).

data "aws_iam_policy_document" "kms" {
  # The account's IAM policies govern the key (the AWS default statement). Without
  # it no role, the execution role included, could be granted kms:Decrypt.
  statement {
    sid       = "AccountIamPolicies"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }
  }

  # CloudWatch Logs encrypts the module's three log groups, and only those.
  statement {
    sid       = "CloudWatchLogsForTheModuleLogGroups"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values = [
        for group in [local.log_group_name, local.flow_log_group_name, local.dns_query_log_group_name] :
        "arn:aws:logs:${var.region}:${var.aws_account_id}:log-group:${group}"
      ]
    }
  }
}

resource "aws_kms_key" "worker" {
  description             = "Conductia discovery worker: secrets, probe parameters, logs, image repository"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "worker" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.worker.key_id
}
