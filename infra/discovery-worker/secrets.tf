# Secret containers only (design R9; A16). No secret value is ever in this module
# or its state: the owner sets each value with put-secret-value from a local file
# (runbook steps 3, 4 and 8). This module never declares a secret version, and
# never manages or reads an SSM parameter (see the probe parameters below).

resource "aws_secretsmanager_secret" "supabase_worker_key" {
  name        = var.worker_supabase_secret_name
  description = "The discovery-worker-aws Supabase secret key (sb_secret_...), injected as SUPABASE_SECRET_KEY (P1 = A)"
  kms_key_id  = aws_kms_key.worker.arn
}

resource "aws_secretsmanager_secret" "queue_url" {
  name        = "discovery-queue-database-url"
  description = "Session-pooler URL as the discovery_queue login (pgboss schema only), injected as DISCOVERY_QUEUE_DATABASE_URL"
  kms_key_id  = aws_kms_key.worker.arn
}

# The two workload identity configs are not secrets but are tamper-sensitive
# (audience, impersonation URL), so they share the secrets' path and key (design R6).
resource "aws_secretsmanager_secret" "wif_dwd" {
  name        = "google-wif-dwd-config"
  description = "The #342 kit's DWD credential config (the signing mode is which file), injected as GOOGLE_WIF_DWD_CONFIG"
  kms_key_id  = aws_kms_key.worker.arn
}

# The message index's digest key (#461, D93; owner, 2026-10-17): the worker
# derives each tenant's HMAC key from it. A random value of at least 32
# characters, never logged and never rotated without re-indexing.
resource "aws_secretsmanager_secret" "index_digest_key" {
  name        = "discovery-index-digest-key"
  description = "The message index's HMAC digest key (#461), injected as DISCOVERY_INDEX_DIGEST_KEY"
  kms_key_id  = aws_kms_key.worker.arn
}

resource "aws_secretsmanager_secret" "wif_directory" {
  name        = "google-wif-directory-config"
  description = "The #342 kit's directory credential config, injected as GOOGLE_WIF_DIRECTORY_CONFIG"
  kms_key_id  = aws_kms_key.worker.arn
}

# P2 = B, or the demo-only classify-propose run (#460). No task references it,
# and the execution role cannot read it, until extract_gateway_enabled or
# propose_gateway_enabled is true (design P2).
resource "aws_secretsmanager_secret" "ai_gateway" {
  name        = "ai-gateway-api-key"
  description = "Model gateway key for the extract worker; unused until P2 switches to B"
  kms_key_id  = aws_kms_key.worker.arn
}

locals {
  # The probe's two dedicated test accounts (design R15, O8), injected into the
  # probe family only. Not managed here: a managed SSM parameter is refreshed
  # into state with its decrypted value, ignore_changes or not. The owner creates
  # both as SecureString under the worker key (runbook step 3), and the module
  # names them by their constructed ARNs.
  probe_parameter_names = {
    mailbox      = "${local.probe_parameter_prefix}/mailbox"
    out_of_scope = "${local.probe_parameter_prefix}/out-of-scope"
  }
  probe_parameter_arns = {
    for key, name in local.probe_parameter_names : key => "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${name}"
  }

  # What the execution role may read. The gateway key joins only under P2 = B or
  # while the demo-only classify-propose family exists (#460).
  readable_secret_arns = concat(
    [
      aws_secretsmanager_secret.supabase_worker_key.arn,
      aws_secretsmanager_secret.queue_url.arn,
      aws_secretsmanager_secret.wif_dwd.arn,
      aws_secretsmanager_secret.wif_directory.arn,
      aws_secretsmanager_secret.index_digest_key.arn,
    ],
    var.extract_gateway_enabled || var.propose_gateway_enabled ? [aws_secretsmanager_secret.ai_gateway.arn] : [],
  )
}
