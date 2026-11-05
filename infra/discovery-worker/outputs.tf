# What the runbook's commands and the #342 kit need. No output is a secret value
# or an address.

output "task_role_arn" {
  description = "The task role ARN. The kit's TASK_ROLE_NAME is its name; G6 records the observed STS ARN."
  value       = aws_iam_role.task.arn
}

output "task_role_name" {
  description = "The kit's TASK_ROLE_NAME."
  value       = aws_iam_role.task.name
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.worker.name
}

output "service_names" {
  description = "The classify and extract services (both exist from stage 2, at desired count 0)."
  value       = local.services
}

output "task_families" {
  description = "The six task-definition families (registered in stage 2; classify_propose only behind propose_gateway_enabled)."
  value       = local.families
}

output "task_images" {
  description = "The image every registered family runs: <repository>@sha256:<digest>. Empty in stage 1."
  value = merge(
    { for name, def in aws_ecs_task_definition.classify : "classify" => jsondecode(def.container_definitions)[0].image },
    { for name, def in aws_ecs_task_definition.extract : "extract" => jsondecode(def.container_definitions)[0].image },
    { for name, def in aws_ecs_task_definition.probe : "probe" => jsondecode(def.container_definitions)[0].image },
    { for name, def in aws_ecs_task_definition.once : "once" => jsondecode(def.container_definitions)[0].image },
    { for name, def in aws_ecs_task_definition.estimate : "estimate" => jsondecode(def.container_definitions)[0].image },
    { for name, def in aws_ecs_task_definition.classify_propose : "classify_propose" => jsondecode(def.container_definitions)[0].image },
  )
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "security_group_id" {
  value = aws_security_group.worker.id
}

output "run_task_network_configuration" {
  description = "The --network-configuration value for aws ecs run-task, complete: private subnets, the worker group, no public IP."
  value       = "awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.worker.id}],assignPublicIp=DISABLED}"
}

output "secret_arns" {
  description = "The secret containers. Their values are set by the owner from files, never by this module."
  value = {
    supabase_worker_key = aws_secretsmanager_secret.supabase_worker_key.arn
    queue_url           = aws_secretsmanager_secret.queue_url.arn
    wif_dwd             = aws_secretsmanager_secret.wif_dwd.arn
    wif_directory       = aws_secretsmanager_secret.wif_directory.arn
    index_digest_key    = aws_secretsmanager_secret.index_digest_key.arn
    ai_gateway          = aws_secretsmanager_secret.ai_gateway.arn
  }
}

output "probe_parameter_names" {
  description = "The two SSM parameters the owner creates at runbook step 3 (not managed here, so no value is in state)."
  value       = local.probe_parameter_names
}

output "ecr_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "ecr_repository_name" {
  value = aws_ecr_repository.worker.name
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.worker.name
}

output "kms_key_arn" {
  value = aws_kms_key.worker.arn
}

output "deploy_role_arn" {
  description = "The role the owner assumes (with MFA, or through Identity Center) for the push, the probe and once runs and the stop lever: the deploy profile's role_arn."
  value       = aws_iam_role.deploy.arn
}

output "alert_topic_arn" {
  description = "The alert topic: the owner's and the CCO's subscriptions, the regional rules and every alarm."
  value       = aws_sns_topic.alerts.arn
}

output "global_alert_topic_arn" {
  description = "The topic of the global-service rules (IAM, root sign-in) in us-east-1: the alert topic itself when the region is us-east-1."
  value       = local.global_alert_topic_arn
}

output "dns_firewall_rule_group_id" {
  description = "The DNS Firewall rule group on the VPC (G8: the everything-else rule's action is BLOCK)."
  value       = aws_route53_resolver_firewall_rule_group.worker.id
}

output "dns_query_log_group_name" {
  description = "Resolver query logs: every lookup from the VPC, and the DNS Firewall ALERT and BLOCK hits."
  value       = aws_cloudwatch_log_group.dns.name
}

output "flow_log_group_name" {
  value = aws_cloudwatch_log_group.flow.name
}

output "guardduty_detector_id" {
  description = "The detector carrying Fargate runtime monitoring (created here, or the owner's existing one)."
  value       = local.guardduty_detector_id
}

output "trail_name" {
  value = aws_cloudtrail.worker.name
}

output "trail_bucket" {
  value = aws_s3_bucket.trail.bucket
}
