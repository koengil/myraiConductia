# Inputs. The defaults are the shared account and the values Vanta's AWS
# connection screen shows for our workspace.

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
  description = "Region for the provider. IAM is global; this only picks the API endpoint."
  type        = string
  default     = "us-east-1"
}

variable "vanta_scanner_arn" {
  description = "Vanta's scanner role, the only principal allowed to assume vanta-auditor."
  type        = string
  default     = "arn:aws:iam::956993596390:role/scanner"
}

variable "vanta_external_id" {
  description = "External ID from the Vanta AWS connection screen. Not a secret; it guards against a confused deputy."
  type        = string
  default     = "B91189144409463"
}
