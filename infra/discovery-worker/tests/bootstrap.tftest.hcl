# Offline plan tests for the bootstrap order (design R20), and for the lockdown
# and detection set that stage 1 already creates (design R8, R10, R11, R14). The
# AWS provider is a mock: no account, no credentials, no network call. Run by
# scripts/infra/validate.sh and the CI infra_validate job.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b", "us-east-1c"]
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  # The provider still validates ARN-typed arguments, so computed ARNs get
  # well-formed mock values.
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
    }
  }
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000"
    }
  }
  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:123456789012:repository/conductia-discovery-worker"
      repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/conductia-discovery-worker"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/conductia/discovery-worker"
    }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-AbCdEf"
    }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:123456789012:cluster/conductia-discovery"
      id  = "arn:aws:ecs:us-east-1:123456789012:cluster/conductia-discovery"
    }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/mock:1"
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:conductia-discovery-worker-alerts"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::conductia-discovery-worker-trail-123456789012"
    }
  }
  mock_resource "aws_cloudtrail" {
    defaults = {
      arn = "arn:aws:cloudtrail:us-east-1:123456789012:trail/conductia-discovery-worker"
    }
  }
  mock_resource "aws_guardduty_detector" {
    defaults = {
      id = "0123456789abcdef0123456789abcdef"
    }
  }
}

# Distinct secret ARNs, so the execution role's secret read can be checked by set.
override_resource {
  target = aws_secretsmanager_secret.supabase_worker_key
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:supabase-worker-secret-key-AbCdEf" }
}
override_resource {
  target = aws_secretsmanager_secret.queue_url
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:discovery-queue-database-url-AbCdEf" }
}
override_resource {
  target = aws_secretsmanager_secret.wif_dwd
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:google-wif-dwd-config-AbCdEf" }
}
override_resource {
  target = aws_secretsmanager_secret.wif_directory
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:google-wif-directory-config-AbCdEf" }
}
override_resource {
  target = aws_secretsmanager_secret.index_digest_key
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:discovery-index-digest-key-AbCdEf" }
}
override_resource {
  target = aws_secretsmanager_secret.ai_gateway
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-api-key-AbCdEf" }
}

mock_provider "aws" {
  alias = "us_east_1"

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:conductia-discovery-worker-global-alerts"
    }
  }
}

variables {
  aws_account_id         = "123456789012"
  region                 = "us-east-1"
  supabase_url           = "https://example-project.supabase.co"
  probe_tenant_id        = "00000000-0000-4000-8000-000000000001"
  probe_workspace_domain = "bank.example"
  alarm_email            = "owner-alerts@example.invalid"
  cco_alarm_email        = "cco-alerts@example.invalid"

  deploy_principal_type         = "iam_user"
  deploy_trusted_principal_arns = ["arn:aws:iam::123456789012:user/owner"]
}

# Stage 1: no digest. Everything that runs no code, and nothing that could.
run "stage_1_without_a_digest_plans_no_task_definition_or_service" {
  command = plan

  assert {
    condition     = aws_ecr_repository.worker.image_tag_mutability == "IMMUTABLE"
    error_message = "The image repository is planned in stage 1, with immutable tags."
  }
  assert {
    condition     = aws_ecr_repository.worker.image_scanning_configuration[0].scan_on_push
    error_message = "The repository scans on push."
  }
  assert {
    condition     = aws_kms_key.worker.enable_key_rotation
    error_message = "The worker key rotates."
  }
  assert {
    condition     = aws_iam_role.task.name == "conductia-discovery-worker"
    error_message = "The task role is planned in stage 1 under the kit's name."
  }
  assert {
    condition = (
      length(aws_ecs_task_definition.classify) + length(aws_ecs_task_definition.extract) +
      length(aws_ecs_task_definition.probe) + length(aws_ecs_task_definition.once) +
      length(aws_ecs_task_definition.estimate)
    ) == 0
    error_message = "No task definition exists before the image does."
  }
  assert {
    condition     = length(aws_ecs_service.classify) + length(aws_ecs_service.extract) == 0
    error_message = "No service exists before the image does."
  }
  assert {
    condition     = one([for s in aws_ecs_cluster.worker.setting : s.value if s.name == "containerInsights"]) == "enabled"
    error_message = "Container Insights is enabled on the cluster (RunningTaskCount)."
  }

  # The lockdown and detection set exists before any task definition does.
  assert {
    condition     = aws_iam_role.deploy.max_session_duration == 3600
    error_message = "deploy sessions last one hour at most."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Principal.AWS == ["arn:aws:iam::123456789012:user/owner"] &&
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.Bool["aws:MultiFactorAuthPresent"] == "true" &&
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.NumericLessThan["aws:MultiFactorAuthAge"] == "3600"
    )
    error_message = "iam_user: deploy trusts the named users only, with MFA in the last hour."
  }
  assert {
    condition     = aws_cloudtrail.worker.is_multi_region_trail && aws_cloudtrail.worker.include_global_service_events && aws_cloudtrail.worker.enable_log_file_validation
    error_message = "The trail covers every region and global events, with log-file validation."
  }
  assert {
    condition     = aws_flow_log.worker.traffic_type == "ALL"
    error_message = "Flow logs record every flow."
  }
  assert {
    condition     = aws_route53_resolver_firewall_rule.allowed.action == "ALLOW" && aws_route53_resolver_firewall_rule.everything_else.action == "ALERT" && aws_route53_resolver_firewall_rule.everything_else.block_response == null
    error_message = "The DNS Firewall starts in ALERT: the allowlist is allowed, everything else alerts."
  }
  assert {
    condition = alltrue([
      for name in ["*.googleapis.com.", "example-project.supabase.co.", "*.pooler.supabase.com.", "*.dkr.ecr.us-east-1.amazonaws.com.", "guardduty-data.us-east-1.amazonaws.com."] :
      contains(aws_route53_resolver_firewall_domain_list.allowed.domains, name)
    ]) && aws_route53_resolver_firewall_domain_list.everything.domains == toset(["*."])
    error_message = "The allowlist carries the baseline names, the Supabase host included."
  }
  assert {
    condition     = aws_route53_resolver_firewall_config.worker.firewall_fail_open == "DISABLED"
    error_message = "The DNS Firewall fails closed."
  }
  assert {
    condition     = length(aws_guardduty_detector.worker) == 1 && aws_guardduty_detector_feature.runtime_monitoring.name == "RUNTIME_MONITORING"
    error_message = "With no existing detector one is created, with runtime monitoring."
  }
  assert {
    condition     = one([for c in aws_guardduty_detector_feature.runtime_monitoring.additional_configuration : c.status if c.name == "ECS_FARGATE_AGENT_MANAGEMENT"]) == "ENABLED"
    error_message = "Fargate agent management is on."
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.execution.policy, "arn:aws:ecr:us-east-1:593207742271:repository/aws-guardduty-agent-fargate")
    error_message = "The execution role may pull the GuardDuty agent from its us-east-1 repository."
  }
  assert {
    condition     = aws_sns_topic_subscription.owner.protocol == "email" && aws_sns_topic_subscription.cco.protocol == "email"
    error_message = "The alert topic emails the owner and the CCO."
  }
  assert {
    condition     = length(aws_sns_topic.global_alerts) == 0 && length(aws_sns_topic_subscription.global_owner) + length(aws_sns_topic_subscription.global_cco) == 0
    error_message = "In us-east-1 the global-service rules share the alert topic."
  }
  assert {
    condition     = !strcontains(aws_sns_topic_policy.alerts.policy, "sns:*") && strcontains(aws_sns_topic_policy.alerts.policy, "sns:SetTopicAttributes")
    error_message = "The topic policy lists the default actions; SNS rejects \"sns:*\" in a topic policy."
  }
  assert {
    condition = alltrue([
      for name in ["task-role-assumed-outside-ecs", "deploy-role-assumed", "tamper-sns", "tamper-eventbridge", "tamper-cloudwatch"] :
      !contains(keys(aws_cloudwatch_event_rule.global), name) && contains(keys(aws_cloudwatch_event_rule.regional), name)
    ])
    error_message = "In us-east-1 the role-assumption and alert-path rules exist once, in the region."
  }
  assert {
    condition     = toset(keys(aws_cloudwatch_event_rule.regional)) == toset(keys(aws_cloudwatch_event_target.regional)) && toset(keys(aws_cloudwatch_event_rule.global)) == toset(keys(aws_cloudwatch_event_target.global))
    error_message = "Every alert rule has its target."
  }
  assert {
    condition = alltrue([
      for name in ["secret-read-outside-ecs", "task-role-assumed-outside-ecs", "deploy-role-assumed"] :
      aws_cloudwatch_event_rule.regional[name].state == "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"
    ])
    error_message = "The read-only events (GetSecretValue, AssumeRole) are matched only in the all-management-events state."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ticks) + length(aws_cloudwatch_metric_alarm.running_tasks) == 0
    error_message = "At zero the tick and running-task alarms do not exist."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.extract_running_tasks) == 0
    error_message = "Stage 1 has no extract service, so no extract running-task alarm."
  }
  assert {
    condition     = aws_cloudwatch_log_metric_filter.address_in_logs.pattern == "%[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\\.[A-Za-z]+%"
    error_message = "The address alarm's regex is the CloudWatch-supported one."
  }

  # The rendered policies, statement by statement (design R7, R8).
  assert {
    condition = alltrue([
      for role in [aws_iam_role.task, aws_iam_role.execution] :
      jsondecode(role.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:ecs:us-east-1:123456789012:*" &&
      jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    ])
    error_message = "The task and execution roles trust ECS tasks of this account and region (the documented account-scoped form)."
  }
  assert {
    condition = (
      one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "ReadTheTwoProbeParameters"]) == [
        "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/discovery-worker/probe/mailbox",
        "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/discovery-worker/probe/out-of-scope",
      ] &&
      one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "DecryptWithTheWorkerKey"]) == ["arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000"] &&
      one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Condition.StringEquals["kms:ViaService"] if st.Sid == "WriteTheLogGroupThroughLogs"]) == "logs.us-east-1.amazonaws.com"
    )
    error_message = "The execution role reads exactly the two probe parameters, decrypts with the worker key, and writes logs through Logs only."
  }
  assert {
    condition = toset([for st in jsondecode(aws_iam_role_policy.deploy.policy).Statement : st.Sid]) == toset([
      "EcrAuthorizationToken", "PushToTheWorkerRepository", "UpdateTheTwoServices", "RunTheProbeAndOnceFamilies",
      "StopTheClusterTasks", "ListTheClusterTasks", "ReadTheRunsItStarts", "DescribeTaskDefinitions", "PassOnlyTheTwoWorkerRoles",
      "NeverExec", "NeverChangeIam", "NeverTouchSecrets", "NeverUseKms",
    ])
    error_message = "deploy holds exactly its statements: no RegisterTaskDefinition, no log read."
  }
  assert {
    condition = alltrue([
      for st in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      st.Condition.ArnEquals["ecs:cluster"] == "arn:aws:ecs:us-east-1:123456789012:cluster/conductia-discovery"
      if contains(["UpdateTheTwoServices", "RunTheProbeAndOnceFamilies", "StopTheClusterTasks", "ListTheClusterTasks"], st.Sid)
    ])
    error_message = "Every deploy ECS write and the task list are pinned to the worker cluster."
  }
  assert {
    condition = (
      one([for st in jsondecode(aws_iam_role_policy.deploy.policy).Statement : st.Resource if st.Sid == "StopTheClusterTasks"]) == "arn:aws:ecs:us-east-1:123456789012:task/conductia-discovery/*" &&
      !strcontains(aws_iam_role_policy.deploy.policy, "RegisterTaskDefinition") &&
      !strcontains(aws_iam_role_policy.deploy.policy, "logs:")
    )
    error_message = "StopTask names the cluster's tasks; deploy never registers a revision or reads a log group."
  }
  assert {
    condition     = one([for st in jsondecode(aws_iam_role_policy.deploy.policy).Statement : "${st.Effect} ${st.Action}" if st.Sid == "NeverUseKms"]) == "Deny kms:*"
    error_message = "deploy is denied every kms: action."
  }
  assert {
    condition = (
      one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : "${st.Effect} ${st.Action}" if st.Sid == "ReadTheNamedSecrets"]) == "Allow secretsmanager:GetSecretValue" &&
      toset(one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "ReadTheNamedSecrets"])) == toset([
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:supabase-worker-secret-key-AbCdEf",
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:discovery-queue-database-url-AbCdEf",
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:google-wif-dwd-config-AbCdEf",
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:google-wif-directory-config-AbCdEf",
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:discovery-index-digest-key-AbCdEf",
      ]) &&
      length([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st if strcontains(jsonencode(st.Action), "secretsmanager:")]) == 1
    )
    error_message = "The execution role reads exactly the five injected secrets with GetSecretValue alone; the gateway key stays out under P2 = A."
  }
  assert {
    condition     = output.probe_parameter_names == { mailbox = "/conductia/discovery-worker/probe/mailbox", out_of_scope = "/conductia/discovery-worker/probe/out-of-scope" }
    error_message = "The two probe parameters keep their names, owner-created."
  }
}

# Stage 2: a digest. Five families, both services at zero, every image by digest.
run "stage_2_registers_five_families_and_both_services_at_zero" {
  command = apply

  variables {
    image_digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  assert {
    condition = (
      length(aws_ecs_task_definition.classify) + length(aws_ecs_task_definition.extract) +
      length(aws_ecs_task_definition.probe) + length(aws_ecs_task_definition.once) +
      length(aws_ecs_task_definition.estimate)
    ) == 5
    error_message = "Stage 2 registers the five families."
  }
  assert {
    condition     = aws_ecs_service.classify[0].desired_count == 0 && aws_ecs_service.extract[0].desired_count == 0
    error_message = "Both services are created at desired count 0."
  }
  assert {
    condition = alltrue([
      for def in concat(aws_ecs_task_definition.classify, aws_ecs_task_definition.extract, aws_ecs_task_definition.probe, aws_ecs_task_definition.once, aws_ecs_task_definition.estimate) :
      endswith(jsondecode(def.container_definitions)[0].image, "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
    ])
    error_message = "Every container image ends in @sha256:<digest>."
  }
  assert {
    condition     = length(output.task_images) == 5
    error_message = "The task_images output lists the five families for the runbook's digest check."
  }
  assert {
    condition = alltrue([
      for def in concat(aws_ecs_task_definition.classify, aws_ecs_task_definition.extract, aws_ecs_task_definition.probe, aws_ecs_task_definition.once, aws_ecs_task_definition.estimate) :
      jsondecode(def.container_definitions)[0].readonlyRootFilesystem
    ])
    error_message = "Every container runs with a read-only root."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.probe[0].container_definitions)[0].command == ["probe", "--live", "--confirm-domain", "bank.example", "--tenant", "00000000-0000-4000-8000-000000000001", "--allow-remote-db", "--out", "/tmp/probe"]
    error_message = "The probe family carries the fixed R15 command."
  }
  assert {
    condition = [for secret in jsondecode(aws_ecs_task_definition.probe[0].container_definitions)[0].secrets : secret.valueFrom if startswith(secret.name, "PROBE_")] == [
      "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/discovery-worker/probe/mailbox",
      "arn:aws:ssm:us-east-1:123456789012:parameter/conductia/discovery-worker/probe/out-of-scope",
    ]
    error_message = "The probe family reads the two owner-created parameters by their constructed ARNs."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.once[0].container_definitions)[0].command == ["classify-once", "--tenant", "00000000-0000-4000-8000-000000000001"]
    error_message = "The once family carries the fixed classify-once command."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.extract[0].container_definitions)[0].command == ["extract"]
    error_message = "With the gateway flag off the extract family runs the bare recorded command and names no tenant."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.estimate[0].container_definitions)[0].command == ["estimate", "--tenant", "00000000-0000-4000-8000-000000000001"]
    error_message = "The estimate family carries the fixed estimate command."
  }
  assert {
    condition = alltrue([
      for s in concat(aws_ecs_service.classify, aws_ecs_service.extract) :
      !s.enable_execute_command && !s.network_configuration[0].assign_public_ip
    ])
    error_message = "No service has ECS Exec or a public IP."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ticks) + length(aws_cloudwatch_metric_alarm.running_tasks) == 0
    error_message = "Stage 2 at zero: the tick and running-task alarms still do not exist."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.extract_running_tasks) == 0
    error_message = "Stage 2 at extract count 0: the extract running-task alarm does not exist."
  }
  assert {
    condition = (
      length(aws_ecs_task_definition.classify_propose) == 0 &&
      length(one([for st in jsondecode(aws_iam_role_policy.deploy.policy).Statement : st.Resource if st.Sid == "RunTheProbeAndOnceFamilies"])) == 3 &&
      !strcontains(aws_iam_role_policy.deploy.policy, "classify-propose")
    )
    error_message = "With propose_gateway_enabled off the demo classify-propose family is not registered and deploy cannot run it (#460)."
  }
}

# A count above zero without start_approved fails the plan.
run "classify_above_zero_without_start_approved_is_refused" {
  command = plan

  variables {
    image_digest           = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    classify_desired_count = 1
    start_approved         = false
  }

  expect_failures = [aws_ecs_service.classify]
}

run "extract_above_zero_without_start_approved_is_refused" {
  command = plan

  variables {
    image_digest          = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    extract_desired_count = 1
    start_approved        = false
  }

  expect_failures = [aws_ecs_service.extract]
}

# The start step's two-variable change is the only way to run.
run "classify_runs_only_with_start_approved" {
  command = plan

  variables {
    image_digest           = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    classify_desired_count = 1
    start_approved         = true
  }

  assert {
    condition     = aws_ecs_service.classify[0].desired_count == 1
    error_message = "With start_approved the classify service plans one task."
  }
  assert {
    condition     = aws_ecs_service.extract[0].desired_count == 0
    error_message = "Extract stays at zero (P2)."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ticks) == 1 && length(aws_cloudwatch_metric_alarm.running_tasks) == 1
    error_message = "A running worker has the tick and running-task alarms."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.ticks[0].treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.running_tasks[0].treat_missing_data == "breaching"
    error_message = "A silent worker alarms: missing data is breaching."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.running_tasks[0].dimensions.ServiceName == "conductia-discovery-classify"
    error_message = "The running-task alarm watches the classify service."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.extract_running_tasks) == 0
    error_message = "Extract at zero has no running-task alarm of its own."
  }
}

# The extract alarm is gated like the extract service: stage 2 and a count above zero (#474).
run "a_running_extract_service_has_its_running_task_alarm" {
  command = apply

  variables {
    image_digest          = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    extract_desired_count = 1
    start_approved        = true
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.extract_running_tasks) == 1 && length(aws_cloudwatch_metric_alarm.running_tasks) == 0
    error_message = "A running extract service has its own running-task alarm; classify at zero has none."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.extract_running_tasks[0].alarm_name == "conductia-discovery-extract-no-running-task"
    error_message = "The extract alarm has its fixed name."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.extract_running_tasks[0].dimensions.ServiceName == "conductia-discovery-extract" && aws_cloudwatch_metric_alarm.extract_running_tasks[0].dimensions.ClusterName == "conductia-discovery"
    error_message = "The extract alarm watches the extract service in the worker cluster."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.extract_running_tasks[0].treat_missing_data == "breaching"
    error_message = "A silent extract service alarms: missing data is breaching."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.extract_running_tasks[0].alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:conductia-discovery-worker-alerts"]) &&
      aws_cloudwatch_metric_alarm.extract_running_tasks[0].ok_actions == toset(["arn:aws:sns:us-east-1:123456789012:conductia-discovery-worker-alerts"])
    )
    error_message = "The extract alarm and its recovery go to the alert topic."
  }
}

run "without_a_digest_an_extract_count_plans_no_extract_alarm" {
  command = plan

  variables {
    extract_desired_count = 1
    start_approved        = true
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.extract_running_tasks) == 0
    error_message = "Stage 1 has no extract service to watch."
  }
}

run "a_55_character_task_role_name_is_accepted" {
  command = plan

  variables {
    task_role_name = "conductia-discovery-worker-with-a-name-that-is-too-long"
  }

  assert {
    condition     = length(aws_iam_role.task.name) == 55
    error_message = "The kit's cap is 55 characters, inclusive."
  }
}

run "a_56_character_task_role_name_is_refused" {
  command = plan

  variables {
    task_role_name = "conductia-discovery-worker-with-a-name-that-is-too-longx"
  }

  expect_failures = [var.task_role_name]
}

run "a_tag_shaped_image_digest_is_refused" {
  command = plan

  variables {
    image_digest = "0123456789abcdef0123456789abcdef01234567-1"
  }

  expect_failures = [var.image_digest]
}

# The detection set's variants (design R8, R10, R11).

run "an_existing_guardduty_detector_is_reused_not_duplicated" {
  command = plan

  variables {
    guardduty_detector_id = "fedcba9876543210fedcba9876543210"
  }

  assert {
    condition     = length(aws_guardduty_detector.worker) == 0
    error_message = "An account holds one detector per region: none is created when one exists."
  }
  assert {
    condition     = aws_guardduty_detector_feature.runtime_monitoring.detector_id == "fedcba9876543210fedcba9876543210"
    error_message = "Runtime monitoring is added to the owner's detector."
  }
}

run "dns_firewall_block_answers_nxdomain" {
  command = plan

  variables {
    dns_firewall_action = "BLOCK"
    dns_allowlist       = ["missing-platform-name.example.com"]
  }

  assert {
    condition     = aws_route53_resolver_firewall_rule.everything_else.action == "BLOCK" && aws_route53_resolver_firewall_rule.everything_else.block_response == "NXDOMAIN"
    error_message = "BLOCK answers NXDOMAIN for every name outside the allowlist."
  }
  assert {
    condition     = contains(aws_route53_resolver_firewall_domain_list.allowed.domains, "missing-platform-name.example.com.") && contains(aws_route53_resolver_firewall_domain_list.allowed.domains, "*.googleapis.com.")
    error_message = "A name added to dns_allowlist joins the baseline."
  }
}

run "a_bare_wildcard_is_not_an_allowlist_entry" {
  command = plan

  variables {
    dns_allowlist = ["*"]
  }

  expect_failures = [var.dns_allowlist]
}

run "sso_trust_names_the_reserved_role_pattern_without_the_mfa_condition" {
  command = plan

  variables {
    deploy_principal_type         = "sso"
    deploy_trusted_principal_arns = ["arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_ConductiaDeploy_*"]
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Principal.AWS == "arn:aws:iam::123456789012:root" &&
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.ArnLike["aws:PrincipalArn"] == ["arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_ConductiaDeploy_*"] &&
      !strcontains(aws_iam_role.deploy.assume_role_policy, "MultiFactorAuth")
    )
    error_message = "sso: the reserved permission-set role only; MFA is enforced in Identity Center (documented deviation)."
  }
  assert {
    condition     = aws_iam_role.deploy.max_session_duration == 3600
    error_message = "deploy sessions last one hour at most under SSO too."
  }
}

run "sso_type_with_an_iam_user_is_refused" {
  command = plan

  variables {
    deploy_principal_type         = "sso"
    deploy_trusted_principal_arns = ["arn:aws:iam::123456789012:user/owner"]
  }

  expect_failures = [aws_iam_role.deploy]
}

run "the_account_root_is_never_a_deploy_principal" {
  command = plan

  variables {
    deploy_trusted_principal_arns = ["arn:aws:iam::123456789012:root"]
  }

  expect_failures = [aws_iam_role.deploy]
}

run "a_wildcard_is_never_a_deploy_principal" {
  command = plan

  variables {
    deploy_trusted_principal_arns = ["*"]
  }

  expect_failures = [aws_iam_role.deploy]
}

run "a_principal_of_another_account_is_refused" {
  command = plan

  variables {
    deploy_trusted_principal_arns = ["arn:aws:iam::210987654321:user/owner"]
  }

  expect_failures = [aws_iam_role.deploy]
}

run "outside_us_east_1_the_global_rules_get_their_own_topic_and_both_subscriptions" {
  command = plan

  variables {
    region = "eu-west-1"
  }

  assert {
    condition     = length(aws_sns_topic.global_alerts) == 1 && length(aws_sns_topic_subscription.global_owner) == 1 && length(aws_sns_topic_subscription.global_cco) == 1
    error_message = "The us-east-1 topic exists, with the owner's and the CCO's subscriptions."
  }
  assert {
    condition     = !strcontains(aws_sns_topic_policy.global_alerts[0].policy, "sns:*")
    error_message = "The us-east-1 topic policy lists explicit actions; SNS rejects \"sns:*\" in a topic policy."
  }
  assert {
    condition     = contains(keys(aws_cloudwatch_event_rule.global), "task-role-assumed-outside-ecs") && contains(keys(aws_cloudwatch_event_rule.global), "deploy-role-assumed")
    error_message = "Role assumptions through the global STS endpoint are paged too."
  }
  assert {
    condition = alltrue([
      for name in ["tamper-sns", "tamper-eventbridge", "tamper-cloudwatch"] :
      contains(keys(aws_cloudwatch_event_rule.global), name) && contains(keys(aws_cloudwatch_event_rule.regional), name)
    ])
    error_message = "The us-east-1 topic and rules are watched for tampering too."
  }
  assert {
    condition     = jsondecode(aws_iam_role.task.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:ecs:eu-west-1:123456789012:*"
    error_message = "The task role trust follows the region."
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.execution.policy, "arn:aws:ecr:eu-west-1:694911143906:repository/aws-guardduty-agent-fargate")
    error_message = "The GuardDuty agent repository follows the region."
  }
}

run "a_region_without_a_known_agent_repository_is_refused" {
  command = plan

  variables {
    region = "us-gov-west-1"
  }

  expect_failures = [aws_iam_role_policy.execution]
}

run "the_gateway_key_joins_the_secret_read_only_under_p2_b" {
  command = plan

  variables {
    extract_gateway_enabled = true
  }

  assert {
    condition = contains(
      one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "ReadTheNamedSecrets"]),
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-api-key-AbCdEf",
    ) && length(one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "ReadTheNamedSecrets"])) == 6
    error_message = "Under P2 = B the execution role also reads the gateway key, and nothing else is added."
  }
}

run "the_extract_command_names_the_tenant_only_behind_the_gateway_flag" {
  command = apply

  variables {
    image_digest            = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    extract_gateway_enabled = true
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.extract[0].container_definitions)[0].command == ["extract", "--tenant", "00000000-0000-4000-8000-000000000001", "--transport", "gateway"]
    error_message = "Under P2 = B the extract family names the tenant and the gateway transport."
  }
}

# Demo-only (#460; delete with #459): the classify-propose family, its key and
# deploy's RunTask on it exist only behind propose_gateway_enabled.
run "the_propose_family_and_its_run_task_exist_only_behind_its_flag" {
  command = apply

  variables {
    image_digest            = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    propose_gateway_enabled = true
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.classify_propose[0].container_definitions)[0].command == ["classify-once", "--tenant", "00000000-0000-4000-8000-000000000001", "--propose"]
    error_message = "The classify-propose family carries the fixed classify-once --propose command."
  }
  assert {
    condition = (
      [for secret in jsondecode(aws_ecs_task_definition.classify_propose[0].container_definitions)[0].secrets : secret.valueFrom if secret.name == "AI_GATEWAY_API_KEY"] == ["arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-api-key-AbCdEf"] &&
      [for env in jsondecode(aws_ecs_task_definition.classify_propose[0].container_definitions)[0].environment : env.value if env.name == "DISCOVERY_PROPOSE_TRANSPORT"] == ["gateway"]
    )
    error_message = "The classify-propose family holds the gateway key and selects the gateway transport."
  }
  assert {
    condition = alltrue([
      for def in concat(aws_ecs_task_definition.classify, aws_ecs_task_definition.once, aws_ecs_task_definition.probe) :
      !strcontains(def.container_definitions, "AI_GATEWAY_API_KEY") && !strcontains(def.container_definitions, "DISCOVERY_PROPOSE_TRANSPORT")
    ])
    error_message = "The classify service, once and probe never hold the gateway key, the flag on or off."
  }
  assert {
    condition = (
      contains(
        one([for st in jsondecode(aws_iam_role_policy.deploy.policy).Statement : st.Resource if st.Sid == "RunTheProbeAndOnceFamilies"]),
        "arn:aws:ecs:us-east-1:123456789012:task-definition/conductia-discovery-classify-propose:*",
      ) &&
      length(one([for st in jsondecode(aws_iam_role_policy.deploy.policy).Statement : st.Resource if st.Sid == "RunTheProbeAndOnceFamilies"])) == 4
    )
    error_message = "Behind its flag deploy may run the classify-propose family, and nothing else is added."
  }
  assert {
    condition = contains(
      one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "ReadTheNamedSecrets"]),
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-api-key-AbCdEf",
    ) && length(one([for st in jsondecode(aws_iam_role_policy.execution.policy).Statement : st.Resource if st.Sid == "ReadTheNamedSecrets"])) == 6
    error_message = "Behind its flag the execution role also reads the gateway key, and nothing else is added."
  }
  assert {
    condition     = length(output.task_images) == 6
    error_message = "The task_images output lists the classify-propose family too while it exists."
  }
}
