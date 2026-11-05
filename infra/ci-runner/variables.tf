# Inputs. Account-specific values may go in a tfvars file, which never enters
# the repo (.gitignore: infra/**/*.tfvars). The PAT is never an input.

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
  description = "Region for the runners."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.region))
    error_message = "region must be an AWS region name, for example us-east-1."
  }
}

variable "github_repo" {
  description = "owner/name of the repository the runners register to."
  type        = string
  default     = "Conductia/Conductia"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must be owner/name."
  }
}

variable "vpc_cidr" {
  description = "CIDR of the runners' VPC."
  type        = string
  default     = "10.60.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be an IPv4 CIDR block."
  }
}

variable "availability_zone" {
  description = "AZ of the single public subnet."
  type        = string
  default     = "us-east-1a"
}

variable "runner_classes" {
  description = <<-EOT
    Runner classes: instance count, type, runner labels, root volume size (GiB)
    and idle minutes before the instance stops itself. Every label must start
    with conductia-ci-. A class whose name starts with "burst" is started by the
    wake function only after the other classes that serve the same jobs.
  EOT
  type = map(object({
    count         = number
    instance_type = string
    labels        = list(string)
    volume_gb     = number
    idle_minutes  = number
  }))
  default = {
    heavy = { count = 2, instance_type = "m6a.xlarge", labels = ["conductia-ci-heavy", "conductia-ci-light"], volume_gb = 100, idle_minutes = 15 }
    burst = { count = 2, instance_type = "m6a.xlarge", labels = ["conductia-ci-heavy", "conductia-ci-light"], volume_gb = 100, idle_minutes = 10 }
    light = { count = 2, instance_type = "m6a.large", labels = ["conductia-ci-light"], volume_gb = 60, idle_minutes = 15 }
  }

  validation {
    condition = alltrue([
      for k, c in var.runner_classes :
      can(regex("^[a-z][a-z0-9]{0,15}$", k)) && c.count >= 0 && c.count <= 10 && c.volume_gb >= 30 && length(c.labels) > 0 &&
      c.idle_minutes == floor(c.idle_minutes) && c.idle_minutes >= 5 && c.idle_minutes <= 240 &&
      alltrue([for l in c.labels : can(regex("^conductia-ci-[a-z0-9-]+$", l))])
    ])
    error_message = "Each class: lowercase name, count 0..10, volume_gb >= 30, idle_minutes a whole number 5..240, labels non-empty and all matching conductia-ci-*."
  }
}

variable "ami_id" {
  description = "Pin an AMI. Null reads the current Ubuntu 24.04 amd64 AMI from Canonical's public SSM parameter."
  type        = string
  default     = null

  validation {
    condition     = var.ami_id == null || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id must be an AMI id (ami-...)."
  }
}

variable "log_retention_days" {
  description = "Retention of the runner and wake-function log groups."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch retention value (1..365)."
  }
}

variable "wake_enabled" {
  description = "Whether the one-minute wake schedule is enabled."
  type        = bool
  default     = true
}
