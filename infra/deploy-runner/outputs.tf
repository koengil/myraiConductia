output "app_key_kms_key_arn" {
  description = "The App-key KMS key; O3 puts the App private key under its alias."
  value       = aws_kms_key.app_key.arn
}

output "app_key_kms_alias" {
  value = aws_kms_alias.app_key.name
}

output "app_key_parameter" {
  description = "The SSM SecureString O3 creates by hand. Never managed by tofu."
  value       = local.app_key_parameter
}

output "launcher_function_name" {
  value = aws_lambda_function.launcher.function_name
}

output "launcher_role_arn" {
  value = aws_iam_role.launcher.arn
}

output "launcher_log_group" {
  value = aws_cloudwatch_log_group.launcher.name
}

output "launch_template_id" {
  value = aws_launch_template.deploy.id
}

output "launch_template_version" {
  description = "The version the launcher passes on every launch."
  value       = aws_launch_template.deploy.latest_version
}

output "deploy_security_group_id" {
  value = aws_security_group.deploy.id
}

output "deploy_alerts_topic_arn" {
  description = "The alert topic every deploy runner alarm notifies; O10 subscribes an email to it."
  value       = aws_sns_topic.alerts.arn
}

output "launcher_guard_policy_arn" {
  description = "The launcher guard (design R21). This module attaches it to the CI fleet's three roles; O16 attaches it to every other principal that is not a launcher admin."
  value       = aws_iam_policy.launcher_guard.arn
}
