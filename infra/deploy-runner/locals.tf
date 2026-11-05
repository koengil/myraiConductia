# Names shared across the module. Everything is named conductia-deploy-runner*,
# outside the CI operator's conductia-ci-runner* scope, so the operator's own
# policy never reaches it.

locals {
  name          = "conductia-deploy-runner"
  launcher_name = "conductia-deploy-runner-launch"
  component     = "deploy-runner"
  github_org    = split("/", var.github_repo)[0]

  # The CI fleet's VPC and public subnet (infra/ci-runner/network.tf), found by tag.
  ci_runner_name = "conductia-ci-runner"

  # The App private key. Never declared in tofu, as a resource or a data source:
  # either would read the value with decryption on refresh, which the key policy
  # denies to everyone but the launcher (design R20, review 1 #15). The owner
  # creates it (O3); this module only builds its ARN.
  app_key_parameter     = "/conductia/deploy-runner/github-app-key"
  app_key_parameter_arn = "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${local.app_key_parameter}"

  # A deploy VM serves one job of at most 30 minutes; 3 live at once covers a
  # promotion's chain with room for a retry.
  instance_type = "m6a.large"
  volume_gb     = 30
  cap           = 3

  # The boot script. It ships inside the launcher's package (launcher.tf), and the
  # launcher puts each runner's JIT config in place of __JIT_CONFIG__.
  user_data_script = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    runner_version     = var.runner_version
    runner_sha256      = var.runner_sha256
    node_version       = var.node_version
    node_sha256        = var.node_sha256
    playwright_version = var.playwright_version
  })

  tags = {
    Project   = "conductia"
    Component = local.component
    ManagedBy = "opentofu"
    Ticket    = "ADR-0028"
  }
}
