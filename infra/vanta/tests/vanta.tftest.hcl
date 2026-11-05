# Offline plan tests for infra/vanta. The AWS provider is a mock (no account,
# no credentials, no network call). Run by scripts/infra/validate.sh.

mock_provider "aws" {
  # The mock's random string is not a policy; the role needs valid JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::123456789012:policy/VantaAdditionalPermissions"
    }
  }
}

variables {
  aws_account_id = "123456789012"
}

run "only_vanta_can_assume_the_read_only_role" {
  command = plan

  assert {
    condition = (
      one(data.aws_iam_policy_document.assume_role.statement[0].principals).identifiers == toset([var.vanta_scanner_arn]) &&
      one(data.aws_iam_policy_document.assume_role.statement[0].condition).variable == "sts:ExternalId" &&
      one(data.aws_iam_policy_document.assume_role.statement[0].condition).values == tolist([var.vanta_external_id])
    )
    error_message = "Only Vanta's scanner may assume the role, and only with our external ID."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.VantaSecurityAudit.policy_arn == "arn:aws:iam::aws:policy/SecurityAudit"
    error_message = "The role gets AWS's read-only SecurityAudit policy."
  }
  assert {
    condition = alltrue([
      for a in ["datapipeline:EvaluateExpression", "datapipeline:QueryObjects", "rds:DownloadDBLogFilePortion"] :
      contains([for s in jsondecode(aws_iam_policy.VantaAdditionalPermissions.policy).Statement : s if s.Effect == "Deny"][0].Action, a)
    ])
    error_message = "The actions that return data, not configuration, stay denied."
  }
}
