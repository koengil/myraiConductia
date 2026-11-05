# Names shared across the module. The six task families and the two services
# are fixed names, so the deploy role's scoping (deploy_role.tf), the runbook's
# commands and the alerts all name the same resources. classify_propose is
# demo-only (#460) and registered only behind propose_gateway_enabled.

locals {
  name         = "conductia-discovery-worker"
  cluster_name = "conductia-discovery"

  families = {
    classify         = "conductia-discovery-classify"
    extract          = "conductia-discovery-extract"
    probe            = "conductia-discovery-probe"
    once             = "conductia-discovery-once"
    estimate         = "conductia-discovery-estimate"
    classify_propose = "conductia-discovery-classify-propose"
  }
  services = {
    classify = "conductia-discovery-classify"
    extract  = "conductia-discovery-extract"
  }

  ecr_repository_name    = "conductia-discovery-worker"
  log_group_name         = "/conductia/discovery-worker"
  probe_parameter_prefix = "/conductia/discovery-worker/probe"

  # Stage 2 begins when the image exists (design R20): until then no task
  # definition or service is planned, so nothing can point at a missing image.
  stage2 = var.image_digest != null

  tags = {
    Project   = "conductia"
    Component = "discovery-worker"
    ManagedBy = "opentofu"
    Ticket    = "344"
  }
}
