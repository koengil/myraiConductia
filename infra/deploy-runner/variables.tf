# Inputs. Account-specific values may go in a tfvars file, which never enters
# the repo (.gitignore: infra/**/*.tfvars). The GitHub App's private key is
# never an input: the owner puts it in SSM by hand (ADR-0028, O3).

variable "aws_account_id" {
  description = "The shared Conductia AWS account (12 digits). The provider refuses any other account."
  type        = string
  default     = "368994863349"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be the 12-digit account id."
  }
}

variable "region" {
  description = "Region of the CI runner VPC, which the deploy VMs share."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.region))
    error_message = "region must be an AWS region name, for example us-east-1."
  }
}

variable "github_repo" {
  description = "owner/name of the only repository whose runs the launcher serves. The owner is the organization that holds the runner group."
  type        = string
  default     = "Conductia/Conductia"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must be owner/name."
  }
}

variable "deploy_runner_group" {
  description = <<-EOT
    The org runner group the launcher mints into. It must resolve to exactly one
    group with visibility "selected", public repositories off and github_repo as
    its only repository, or the launcher mints nothing. Empty is refused the same
    way: the repository-level fallback is not built (design R0).
  EOT
  type        = string
  default     = "conductia-deploy"

  validation {
    condition     = can(regex("^[A-Za-z0-9 ._-]{0,64}$", var.deploy_runner_group))
    error_message = "deploy_runner_group must be a runner group name (letters, digits, space, dot, dash, underscore)."
  }
}

variable "runner_labels" {
  description = <<-EOT
    Every label a minted deploy runner carries. A queued job whose labels are a
    subset of these could take a deploy runner, so it is checked against the
    allowlist (design R25). The default holds GitHub's default labels as well, so
    a bare self-hosted job also counts: loud by mistake is the right failure. The
    O8 canary records the runner's real labels, which then replace this.
  EOT
  type        = list(string)
  default     = ["conductia-deploy", "self-hosted", "Linux", "X64"]

  validation {
    condition = (
      contains(var.runner_labels, "conductia-deploy") &&
      alltrue([for l in var.runner_labels : can(regex("^[A-Za-z0-9._-]+$", l))])
    )
    error_message = "runner_labels must include conductia-deploy, and each label must be letters, digits, dot, dash or underscore."
  }
}

variable "deploy_allowlist" {
  description = <<-EOT
    The runs the launcher serves (design R8): a run's workflow path, branch and
    event must match one entry whose expires (RFC 3339, optional) is not past.
    A called workflow runs inside its caller's run, so a promotion's migrate and
    smoke jobs are admitted by the promotion's entry. Entries without expires are
    the steady state; scripts/ci/runners.test.mjs pins them against the workflows
    that name CI_RUNNER_DEPLOY. Keep one entry per line: that test reads them.
  EOT
  type = list(object({
    workflow = string
    branch   = string
    events   = list(string)
    expires  = optional(string)
  }))
  default = [
    # Steady state.
    { workflow = ".github/workflows/promote-develop-to-staging.yml", branch = "main", events = ["workflow_dispatch"] },
    { workflow = ".github/workflows/promote-staging-to-main.yml", branch = "main", events = ["workflow_dispatch"] },
    { workflow = ".github/workflows/e2e-live-smoke.yml", branch = "main", events = ["workflow_dispatch"] },
    { workflow = ".github/workflows/migrate.yml", branch = "main", events = ["push", "workflow_dispatch"] },
    { workflow = ".github/workflows/migrate.yml", branch = "staging", events = ["push", "workflow_dispatch"] },
    # Bootstrap (design R14): ignored after expires. The O8 positive canary, the Oct 26 dry run and the Oct 29 run.
    { workflow = ".github/workflows/migrate.yml", branch = "develop", events = ["workflow_dispatch"], expires = "2026-10-25T23:59:59Z" },
    { workflow = ".github/workflows/promote-develop-to-staging.yml", branch = "develop", events = ["workflow_dispatch"], expires = "2026-10-27T23:59:59Z" },
    { workflow = ".github/workflows/promote-staging-to-main.yml", branch = "staging", events = ["workflow_dispatch"], expires = "2026-10-30T23:59:59Z" },
  ]

  validation {
    condition = length(var.deploy_allowlist) > 0 && alltrue([
      for e in var.deploy_allowlist :
      contains([
        ".github/workflows/promote-develop-to-staging.yml",
        ".github/workflows/promote-staging-to-main.yml",
        ".github/workflows/e2e-live-smoke.yml",
        ".github/workflows/migrate.yml",
      ], e.workflow) &&
      can(regex("^[A-Za-z0-9._/-]+$", e.branch)) &&
      length(e.events) > 0 &&
      alltrue([for ev in e.events : contains(["push", "workflow_dispatch"], ev)]) &&
      (e.expires == null ? true : can(timeadd(e.expires, "0s")))
    ])
    error_message = "Each deploy_allowlist entry: a deploy workflow path (.github/workflows/<promote-*, e2e-live-smoke, migrate>.yml), a branch name, events from push and workflow_dispatch, and expires either unset or an RFC 3339 timestamp such as 2026-10-25T23:59:59Z."
  }
}

variable "launcher_admin_arns" {
  description = <<-EOT
    The admin principals (ADR-0028, O15): the only ones that may apply this
    module, manage the App-key KMS key and put a rotated key. They can never
    decrypt it. Must hold the applying principal, and should hold two, so one
    deleted principal cannot orphan the key.
  EOT
  type        = list(string)

  validation {
    condition = length(var.launcher_admin_arns) > 0 && alltrue([
      for a in var.launcher_admin_arns : can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/[A-Za-z0-9+=,.@_/-]+$", a))
    ])
    error_message = "launcher_admin_arns must list at least one IAM role or user ARN (arn:aws:iam::<account>:role/<name> or user/<name>)."
  }
}

variable "github_app_id" {
  description = "The launcher GitHub App's id (O3). Empty until the App exists; the schedule cannot be enabled without it."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.github_app_id))
    error_message = "github_app_id must be the App's numeric id, or empty."
  }
}

variable "github_app_installation_id" {
  description = "The App's installation id on the organization (O3). Empty until the App is installed."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.github_app_installation_id))
    error_message = "github_app_installation_id must be numeric, or empty."
  }
}

variable "ami_id" {
  description = <<-EOT
    The deploy VM's AMI, pinned (Ubuntu 24.04 amd64). Never looked up at plan
    time, so an apply never moves it by surprise; a new AMI is a reviewed change
    and a new launch template version. ADR-0028's runbook gives the read that
    resolves the current one.
  EOT
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id must be an AMI id (ami-...)."
  }
}

variable "runner_version" {
  description = "The actions/runner release the deploy VM runs, pinned (design R12). Bump with runner_sha256, at least monthly."
  type        = string
  default     = "2.338.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.runner_version))
    error_message = "runner_version must be a release number such as 2.338.0."
  }
}

variable "runner_sha256" {
  description = "SHA-256 of actions-runner-linux-x64-<runner_version>.tar.gz, from the release asset's digest (ADR-0028 runbook)."
  type        = string
  default     = "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32"

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.runner_sha256))
    error_message = "runner_sha256 must be 64 lowercase hex digits."
  }
}

# Audit V11: the toolchain runs as root on the VM minutes before a job that holds
# production secrets, so it is pinned like the runner, never "latest".
variable "node_version" {
  description = "The Node.js 22 release installed on the deploy VM, pinned. Bump with node_sha256."
  type        = string
  default     = "22.23.4"

  validation {
    condition     = can(regex("^22\\.[0-9]+\\.[0-9]+$", var.node_version))
    error_message = "node_version must be a Node.js 22 release such as 22.23.4."
  }
}

variable "node_sha256" {
  description = "SHA-256 of node-v<node_version>-linux-x64.tar.xz, from https://nodejs.org/dist/v<node_version>/SHASUMS256.txt (ADR-0028 runbook)."
  type        = string
  default     = "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce"

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.node_sha256))
    error_message = "node_sha256 must be 64 lowercase hex digits."
  }
}

variable "playwright_version" {
  description = "The Playwright release whose install-deps the deploy VM runs; the same as package-lock.json's (a test checks)."
  type        = string
  default     = "1.56.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.playwright_version))
    error_message = "playwright_version must be an exact release such as 1.56.0."
  }
}

variable "log_retention_days" {
  description = "Retention of the launcher's log group."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch retention value (1..365)."
  }
}

variable "launcher_enabled" {
  description = "Whether the one-minute launcher schedule runs. Off by default: the first apply creates everything with the schedule disabled, and the second, with the App ids, enables it (O4)."
  type        = bool
  default     = false
}
