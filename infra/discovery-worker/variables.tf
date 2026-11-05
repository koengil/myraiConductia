# Inputs (design R2). Account-specific values live in the owner's tfvars file,
# which never enters the repo (.gitignore: infra/**/*.tfvars). No secret value is
# ever an input: secrets are containers here and the owner sets their values
# from files (design R9).

variable "aws_account_id" {
  description = "Ignatious's dedicated AWS account (12 digits). The provider refuses any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be the 12-digit account id."
  }
}

variable "region" {
  description = "The account's region for the worker (P3; default us-east-1)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.region))
    error_message = "region must be an AWS region name, for example us-east-1."
  }
}

variable "task_role_name" {
  description = "The task role GCP federation trusts. The #342 kit's TASK_ROLE_NAME; at most 55 characters so the STS ARN fits google.subject (design R7)."
  type        = string
  default     = "conductia-discovery-worker"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,55}$", var.task_role_name))
    error_message = "task_role_name must be 1 to 55 characters of [A-Za-z0-9+=,.@_-] (the #342 kit's cap)."
  }
}

variable "image_digest" {
  description = "The pushed image's digest (sha256:<64 hex>). Null in stage 1: no task definition or service exists until the image does (design R20)."
  type        = string
  default     = null

  validation {
    condition     = var.image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be a digest, sha256:<64 lowercase hex>, never a tag."
  }
}

variable "classify_desired_count" {
  description = "Running classify consumers. 0 until runbook step 13; above 0 only with start_approved (design R20)."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.classify_desired_count)
    error_message = "classify_desired_count must be 0 or 1: two consumers never run at once (design R1)."
  }
}

variable "start_approved" {
  description = "Set to true only in runbook step 13, after gates G0 to G9. Any desired count above 0 is refused without it."
  type        = bool
  default     = false
}

variable "extract_desired_count" {
  description = "Running extract workers. 0 until P2 switches to B (design P2)."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.extract_desired_count)
    error_message = "extract_desired_count must be 0 or 1."
  }
}

variable "extract_gateway_enabled" {
  description = "P2 = B only: the extract task reads the model gateway key and uses the gateway transport. Needs the reviewed constants PR and #325 (design P2)."
  type        = bool
  default     = false
}

# Demo-only (#460; delete with #459).
variable "propose_gateway_enabled" {
  description = "Demo only (#460): registers the one-off classify-propose family, which holds the model gateway key next to the mailbox credentials, and lets deploy run it. The proposal step's own locks still refuse a tenant they do not list."
  type        = bool
  default     = false
}

variable "worker_supabase_secret_name" {
  description = "Secrets Manager name of the worker's Supabase secret key (P1 = A: the discovery-worker-aws key). It feeds SUPABASE_SECRET_KEY."
  type        = string
  default     = "supabase-worker-secret-key"

  validation {
    condition     = can(regex("^[A-Za-z0-9/_+=.@-]{1,512}$", var.worker_supabase_secret_name))
    error_message = "worker_supabase_secret_name must be a Secrets Manager name."
  }
}

variable "supabase_url" {
  description = "The hosted Supabase project URL (NEXT_PUBLIC_SUPABASE_URL), https and no path."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.supabase_url))
    error_message = "supabase_url must be https://<host> with no path."
  }
}

variable "probe_tenant_id" {
  description = "The Ignatious tenant id. The task families' fixed commands name it (design R15); it is not an address."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.probe_tenant_id))
    error_message = "probe_tenant_id must be a lowercase UUID."
  }
}

variable "probe_workspace_domain" {
  description = "Ignatious's Workspace domain, the probe's --confirm-domain (design R15)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.probe_workspace_domain))
    error_message = "probe_workspace_domain must be a lowercase domain."
  }
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture; must match the pushed image (design R1)."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "log_retention_days" {
  description = "CloudWatch retention for the worker's log group (design R12)."
  type        = number
  default     = 365

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a value CloudWatch Logs accepts."
  }
}

# The two alert recipients (design R10, O4): the owner and Ignatious's CCO. Each
# alert topic (alerts.tf) subscribes both, from the first apply. Sensitive, so no
# plan output prints an address.
variable "alarm_email" {
  description = "The owner's alert address (O4)."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be an email address."
  }
}

variable "cco_alarm_email" {
  description = "Ignatious's CCO alert address (O4)."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.cco_alarm_email))
    error_message = "cco_alarm_email must be an email address."
  }
}

# The deploy role's trust (design R8, O1). deploy can register a task definition
# naming the secrets and the task role and run it, so holding it equals holding
# the secrets and the Gmail identity: only named principals, with MFA, for an
# hour at most.
variable "deploy_principal_type" {
  description = "How the owner signs in: iam_user (named IAM users, MFA required in the trust) or sso (IAM Identity Center; MFA enforced there, a documented deviation)."
  type        = string

  validation {
    condition     = contains(["iam_user", "sso"], var.deploy_principal_type)
    error_message = "deploy_principal_type must be iam_user or sso."
  }
}

variable "deploy_trusted_principal_arns" {
  description = "Who may assume deploy. iam_user: the named IAM user ARNs (arn:aws:iam::<account>:user/<name>). sso: the permission-set role pattern (arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/[<region>/]AWSReservedSSO_<set>_*). Never the account root or a bare wildcard; checked against the type in deploy_role.tf."
  type        = list(string)

  validation {
    condition     = length(var.deploy_trusted_principal_arns) > 0
    error_message = "deploy_trusted_principal_arns must name at least one principal."
  }
}

# Egress detection (design R11).
variable "dns_allowlist" {
  description = "Names the DNS Firewall allows beyond the baseline the module derives from region and supabase_url (Google APIs, the Supabase project and pooler, the regional AWS endpoints a Fargate task resolves). A name the ALERT phase shows missing is one line here."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for name in var.dns_allowlist : can(regex("^(\\*\\.)?[a-z0-9-]+(\\.[a-z0-9-]+)+$", name))])
    error_message = "Each dns_allowlist entry is a lowercase name, optionally starting with *. (never a bare *)."
  }
}

variable "dns_firewall_action" {
  description = "What the DNS Firewall does with a lookup outside the allowlist: ALERT (logged and alarmed, answered) until runbook step 10, then BLOCK (NXDOMAIN). G8 requires BLOCK."
  type        = string
  default     = "ALERT"

  validation {
    condition     = contains(["ALERT", "BLOCK"], var.dns_firewall_action)
    error_message = "dns_firewall_action must be ALERT or BLOCK."
  }
}

variable "guardduty_detector_id" {
  description = "An existing GuardDuty detector in the region (O1). Null creates one; an account holds at most one per region, so set it when one exists and the module only adds Fargate runtime monitoring to it."
  type        = string
  default     = null

  validation {
    condition     = var.guardduty_detector_id == null || can(regex("^[0-9a-f]{32}$", var.guardduty_detector_id))
    error_message = "guardduty_detector_id must be a 32-character detector id."
  }
}

variable "guardduty_agent_repository_arn" {
  description = "The ECR repository GuardDuty's Fargate agent sidecar is pulled from. Null takes the region's entry from the GuardDuty documentation table in detection.tf; set it only for a region that table lacks."
  type        = string
  default     = null

  validation {
    condition     = var.guardduty_agent_repository_arn == null || can(regex("^arn:aws:ecr:[a-z0-9-]+:[0-9]{12}:repository/aws-guardduty-agent-fargate$", var.guardduty_agent_repository_arn))
    error_message = "guardduty_agent_repository_arn must be arn:aws:ecr:<region>:<account>:repository/aws-guardduty-agent-fargate."
  }
}

variable "cloudtrail_object_lock" {
  description = "Object Lock (GOVERNANCE, log_retention_days) on the trail bucket. Off by default: enabling it on a bucket cannot be undone (design R10)."
  type        = bool
  default     = false
}
