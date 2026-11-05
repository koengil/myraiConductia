output "vanta-auditor-arn" {
  description = "The role ARN to enter in the Vanta UI at the end of the AWS connection steps."
  value       = aws_iam_role.vanta-auditor.arn
}
