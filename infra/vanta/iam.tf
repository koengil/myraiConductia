# Vanta's published role: AWS SecurityAudit plus Identity Center reads, with
# the three actions that can return data (not configuration) denied.

resource "aws_iam_policy" "VantaAdditionalPermissions" {
  name        = "VantaAdditionalPermissions"
  description = "Custom Vanta Policy"
  policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        "Effect" : "Allow",
        "Action" : [
          "identitystore:DescribeGroup",
          "identitystore:DescribeGroupMembership",
          "identitystore:DescribeUser",
          "identitystore:GetGroupId",
          "identitystore:GetGroupMembershipId",
          "identitystore:GetUserId",
          "identitystore:IsMemberInGroups",
          "identitystore:ListGroupMemberships",
          "identitystore:ListGroups",
          "identitystore:ListUsers",
          "identitystore:ListGroupMembershipsForMember",
        ],
        "Resource" : "*"
      },
      {
        "Effect" : "Deny",
        "Action" : [
          "datapipeline:EvaluateExpression",
          "datapipeline:QueryObjects",
          "rds:DownloadDBLogFilePortion"
        ],
        "Resource" : "*"
      }
    ]
  })
}

data "aws_iam_policy_document" "assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      identifiers = [var.vanta_scanner_arn]
      type        = "AWS"
    }
    condition {
      test     = "StringEquals"
      values   = [var.vanta_external_id]
      variable = "sts:ExternalId"
    }
  }
}

resource "aws_iam_role" "vanta-auditor" {
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  name               = "vanta-auditor"
}

resource "aws_iam_role_policy_attachment" "VantaSecurityAudit" {
  role       = aws_iam_role.vanta-auditor.name
  policy_arn = "arn:aws:iam::aws:policy/SecurityAudit"
}

resource "aws_iam_role_policy_attachment" "VantaAdditionalPermissions" {
  role       = aws_iam_role.vanta-auditor.name
  policy_arn = aws_iam_policy.VantaAdditionalPermissions.arn
}
