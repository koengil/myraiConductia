# The cluster, the five task-definition families (six with the demo-only
# classify_propose behind propose_gateway_enabled) and the two services (design
# R1, R15, R18, R20).
#
# Stage 1 (image_digest null): the cluster only. Stage 2 (image_digest set): the
# five families and both services, at desired count 0. A service runs a task only
# when its desired count is above 0, and the precondition below refuses that
# unless start_approved, which only runbook step 13 sets. No ignore_changes on
# desired_count: a console scale-up is reverted by the next apply and shows as
# drift.

resource "aws_ecs_cluster" "worker" {
  name = local.cluster_name

  # RunningTaskCount for the task-count alarm (design R14) is a Container
  # Insights metric.
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  # The image by digest, never by tag (design R3).
  image = local.stage2 ? "${aws_ecr_repository.worker.repository_url}@${var.image_digest}" : null

  # The container contract the image and the module share (design R18). Secrets
  # are injected by name; no value is ever in this module.
  base_environment = [
    { name = "NEXT_PUBLIC_APP_ENV", value = "prod" },
    { name = "DISCOVERY_READER_MODE", value = "live" },
    { name = "NEXT_PUBLIC_SUPABASE_URL", value = var.supabase_url },
  ]
  base_secrets = [
    { name = "SUPABASE_SECRET_KEY", valueFrom = aws_secretsmanager_secret.supabase_worker_key.arn },
    { name = "DISCOVERY_QUEUE_DATABASE_URL", valueFrom = aws_secretsmanager_secret.queue_url.arn },
    { name = "GOOGLE_WIF_DWD_CONFIG", valueFrom = aws_secretsmanager_secret.wif_dwd.arn },
    { name = "GOOGLE_WIF_DIRECTORY_CONFIG", valueFrom = aws_secretsmanager_secret.wif_directory.arn },
    { name = "DISCOVERY_INDEX_DIGEST_KEY", valueFrom = aws_secretsmanager_secret.index_digest_key.arn },
  ]

  # Read-only root; /tmp is the one writable path, an ephemeral task volume the
  # image seeds with a node-owned /tmp/google (design R6). The image's USER node
  # stands: no container sets a user.
  base_container = {
    name                   = "worker"
    image                  = local.image
    essential              = true
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = local.base_environment
    secrets                = local.base_secrets
    # The consumer stops gracefully within 30 s of SIGTERM (design R21 lever 2).
    stopTimeout = 40
  }

  log_configuration = {
    for family, _ in local.families : family => {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = family
      }
    }
  }
}

# The long-running pg-boss consumer.
resource "aws_ecs_task_definition" "classify" {
  count = local.stage2 ? 1 : 0

  family                   = local.families.classify
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.base_container, {
    command          = ["classify"]
    logConfiguration = local.log_configuration.classify
  })])
}

# The deal-zone extractor (design P2). Desired count 0 until P2 switches to B.
# Behind extract_gateway_enabled its fixed command names the deal tenant and the
# gateway transport; the processor gate (#432) still refuses a tenant it does not
# list. With the flag off it runs the bare recorded command on the dev tenant, so
# a recorded run never reads, or fails, a real tenant's items. It reads text
# through a definer RPC and never a reader, so it holds no Google config, no
# queue URL and no task role.
resource "aws_ecs_task_definition" "extract" {
  count = local.stage2 ? 1 : 0

  family                   = local.families.extract
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.base_container, {
    command = var.extract_gateway_enabled ? ["extract", "--tenant", var.probe_tenant_id, "--transport", "gateway"] : ["extract"]
    environment = [
      { name = "NEXT_PUBLIC_APP_ENV", value = "prod" },
      { name = "NEXT_PUBLIC_SUPABASE_URL", value = var.supabase_url },
      { name = "DISCOVERY_EXTRACT_TRANSPORT", value = var.extract_gateway_enabled ? "gateway" : "recorded" },
    ]
    secrets = concat(
      [{ name = "SUPABASE_SECRET_KEY", valueFrom = aws_secretsmanager_secret.supabase_worker_key.arn }],
      var.extract_gateway_enabled ? [{ name = "AI_GATEWAY_API_KEY", valueFrom = aws_secretsmanager_secret.ai_gateway.arn }] : [],
    )
    logConfiguration = local.log_configuration.extract
  })])
}

# The connection probe from the task (design R15; gate G5). Same image, roles,
# network, environment and secrets as classify; it differs only in its fixed
# command, which names no address, and in the two test addresses it reads from
# SSM. Run with no --overrides.
resource "aws_ecs_task_definition" "probe" {
  count = local.stage2 ? 1 : 0

  family                   = local.families.probe
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.base_container, {
    command = [
      "probe", "--live",
      "--confirm-domain", var.probe_workspace_domain,
      "--tenant", var.probe_tenant_id,
      "--allow-remote-db",
      "--out", "/tmp/probe",
    ]
    secrets = concat(local.base_secrets, [
      { name = "PROBE_MAILBOX", valueFrom = local.probe_parameter_arns.mailbox },
      { name = "PROBE_OUT_OF_SCOPE", valueFrom = local.probe_parameter_arns.out_of_scope },
    ])
    logConfiguration = local.log_configuration.probe
  })])
}

# One pass over the Ignatious tenant, then exit: the G2 exclusion check only
# (runbook step 11, under the one-allowed-mailbox stop rule).
resource "aws_ecs_task_definition" "once" {
  count = local.stage2 ? 1 : 0

  family                   = local.families.once
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.base_container, {
    command          = ["classify-once", "--tenant", var.probe_tenant_id]
    logConfiguration = local.log_configuration.once
  })])
}

# Demo-only (#460; delete with #459): one classify-once --propose pass over the
# Ignatious tenant, then exit. It is the once family plus the model gateway key
# and the gateway transport, so while it exists the reader task holds the key
# next to the mailbox credentials. It is the only reader family that ever does:
# it is registered only behind propose_gateway_enabled, the classify service
# refuses to start with the key set, and the proposal step's own locks (the
# flag, the tenant list and the processor gate) still refuse a tenant they do
# not list. Fixed command: run with no --overrides.
resource "aws_ecs_task_definition" "classify_propose" {
  count = local.stage2 && var.propose_gateway_enabled ? 1 : 0

  family                   = local.families.classify_propose
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.base_container, {
    command = ["classify-once", "--tenant", var.probe_tenant_id, "--propose"]
    environment = concat(local.base_environment, [
      { name = "DISCOVERY_PROPOSE_TRANSPORT", value = "gateway" },
    ])
    secrets = concat(local.base_secrets, [
      { name = "AI_GATEWAY_API_KEY", valueFrom = aws_secretsmanager_secret.ai_gateway.arn },
    ])
    logConfiguration = local.log_configuration.classify_propose
  })])
}

# The pre-run estimate (#261, design Q4d): content-free statistics of the mail the
# extractor would send and its expected cost, printed as one JSON line. It returns
# no body, builds no model transport and holds no gateway key. Run with no --overrides.
resource "aws_ecs_task_definition" "estimate" {
  count = local.stage2 ? 1 : 0

  family                   = local.families.estimate
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([merge(local.base_container, {
    command = ["estimate", "--tenant", var.probe_tenant_id]
    environment = [
      { name = "NEXT_PUBLIC_APP_ENV", value = "prod" },
      { name = "NEXT_PUBLIC_SUPABASE_URL", value = var.supabase_url },
    ]
    secrets          = [{ name = "SUPABASE_SECRET_KEY", valueFrom = aws_secretsmanager_secret.supabase_worker_key.arn }]
    logConfiguration = local.log_configuration.estimate
  })])
}

resource "aws_ecs_service" "classify" {
  count = local.stage2 ? 1 : 0

  name                               = local.services.classify
  cluster                            = aws_ecs_cluster.worker.id
  task_definition                    = aws_ecs_task_definition.classify[0].arn
  desired_count                      = var.classify_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = false
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  propagate_tags                     = "SERVICE"
  wait_for_steady_state              = false

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  lifecycle {
    precondition {
      condition     = var.classify_desired_count == 0 || var.start_approved
      error_message = "classify_desired_count above 0 needs start_approved = true, which only runbook step 13 sets, after gates G0 to G9."
    }
  }
}

resource "aws_ecs_service" "extract" {
  count = local.stage2 ? 1 : 0

  name                               = local.services.extract
  cluster                            = aws_ecs_cluster.worker.id
  task_definition                    = aws_ecs_task_definition.extract[0].arn
  desired_count                      = var.extract_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = false
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  propagate_tags                     = "SERVICE"
  wait_for_steady_state              = false

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  lifecycle {
    precondition {
      condition     = var.extract_desired_count == 0 || var.start_approved
      error_message = "extract_desired_count above 0 needs start_approved = true (and P2 = B recorded); see the runbook's Switching later section."
    }
  }
}
