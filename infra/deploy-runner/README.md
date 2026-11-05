# infra/deploy-runner

OpenTofu for the deploy runner group (#639). The staging and production deploy jobs (both promotions, the live smoke, and *Migrate database* for `db-staging` and `db-production`) run on just-in-time runners in the org runner group `conductia-deploy`, one fresh VM per job. The launcher Lambda `conductia-deploy-runner-launch` mints a runner only for a run the allowlist admits whose commit is on its branch, and mints nothing while a refused job could take a runner.

The decision, threat model, residual risks and the owner runbook are in [ADR-0028](../../docs/07-decisions/ADR-0028-deploy-runner-group.md); start there, not here. The module is applied only by an admin principal (`launcher_admin_arns`), never by the CI operator that applies `infra/ci-runner/`. It ships dormant: the schedule is disabled until `launcher_enabled = true`, and no deploy job targets the group until the repository variable `CI_RUNNER_DEPLOY` is set.

| File | What it holds |
|---|---|
| `network.tf` | the CI fleet's VPC and public subnet, looked up by tag; the deploy security group (no ingress) |
| `kms.tf` | the App-key KMS key: only the launcher decrypts, admins rotate but never read |
| `launcher.tf` | the pinned launch template (no instance profile), the Lambda, its role (it may terminate only VMs launched from that template) and the role's inline guard variant, log group and schedule |
| `guard.tf` | the launcher guard `conductia-deploy-launcher-guard`, an explicit Deny on changing the launcher, its key, logs, alarms, template and security group, reading a deploy VM's user data, or tagging an instance as a deploy VM; attached to the CI fleet's instance, wake and scheduler roles (the owner attaches it to every other non-admin principal, ADR-0028 O16) |
| `alarms.tf` | the alert topic and its policy; the tripwire, hold and unknown-runner metric filters and alarms; the launcher's `AWS/Lambda` `Errors` alarm |
| `templates/user-data.sh.tftpl` | the VM's boot script: hard cap, pinned runner, `.env` hook, runner first, toolchain after |
| `lambda/deploy.mjs` | the handler, I/O only |
| `lambda/deploy-plan.mjs` | every decision, pure |

Offline checks only, from the repository root: `scripts/infra/validate.sh` (fmt, validate, `tofu test` with a mock provider, then `node --test infra/*/lambda/*.test.mjs`). The App's private key is never declared here: the owner puts it in SSM by hand (ADR-0028, O3).
