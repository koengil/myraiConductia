# Vanta audit role (SOC 2, #467)

The read-only IAM role `vanta-auditor` that Vanta's scanner assumes to run its
automated SOC 2 tests against account 368994863349. The resources are Vanta's
published Terraform, unchanged except that the principal and external ID are
inputs (`variables.tf`).

| Resource | What it grants |
|---|---|
| `vanta-auditor` role | Assumable only by `arn:aws:iam::956993596390:role/scanner` with our external ID |
| `SecurityAudit` (AWS managed) | Read the configuration of nearly every service |
| `VantaAdditionalPermissions` | Read IAM Identity Center users and groups; deny `datapipeline:EvaluateExpression`, `datapipeline:QueryObjects`, `rds:DownloadDBLogFilePortion` |

Output: `vanta-auditor-arn`, entered in the Vanta UI at the end of the AWS
connection steps. Applied 2026-10-22 as
`arn:aws:iam::368994863349:role/vanta-auditor`.

## State

S3 bucket `conductia-vanta-tfstate-368994863349` (us-east-1), key
`vanta/terraform.tfstate`, made by hand on 2026-10-22: versioning on, public
access blocked, bucket-owner-enforced ownership, SSE-KMS with the AWS-managed
`aws/s3` key, a bucket policy that denies non-TLS requests, tags
`Project=conductia`, `Component=vanta`, `ManagedBy=opentofu`. Locking is
OpenTofu's native S3 lockfile.

## Apply

As an admin of the account (any profile; none is pinned here):

```bash
cd infra/vanta
tofu init -backend-config=bucket=conductia-vanta-tfstate-368994863349 -backend-config=region=us-east-1
tofu plan -out=vanta.tfplan
tofu apply vanta.tfplan
```

If Vanta issues a new external ID, pass `-var vanta_external_id=<id>` or change
the default. `tofu destroy` disconnects Vanta from the account.

Offline checks (no account): `scripts/infra/validate.sh`.
