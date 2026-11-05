# CI runner fleet (ADR-0027 trial)

Self-hosted GitHub Actions runners for `Conductia/Conductia` in account
368994863349, us-east-1, on-demand. One runner per EC2 instance:

| Class | Default | Labels | Idle stop |
|---|---|---|---|
| heavy | 2 x m6a.xlarge, 100 GiB gp3 | `conductia-ci-heavy`, `conductia-ci-light` | 15 min |
| burst | 2 x m6a.xlarge, 100 GiB gp3 | `conductia-ci-heavy`, `conductia-ci-light` | 10 min |
| light | 2 x m6a.large, 60 GiB gp3 | `conductia-ci-light` | 15 min |

Each instance stops itself after its class's `idle_minutes` without a job
(`templates/idle-stop.sh`, checked every 2 minutes, so the stop lands up to 2
minutes after the window). The `conductia-ci-runner-wake` Lambda runs every
minute, counts queued jobs that want a `conductia-ci-*` label, and starts
stopped instances to cover them. Burst runners serve the same jobs as heavy
ones but start last: heavy jobs start `heavy`, then `burst`; light jobs start
`light`, then `heavy`, then `burst` (a class whose name starts with `burst` is a
burst class; `lambda/plan.mjs`, tested by `node --test infra/ci-runner/lambda/plan.test.mjs`).
Capacity counts running instances whose runner GitHub does not report busy, so
it can under- or over-start by one for a tick; the next tick corrects it.

The GitHub PAT never reaches a runner host: jobs have docker-group (root)
access, so whatever the instance role can read, any job or npm dependency can
read. Only the wake Lambda reads `/conductia/ci-runner/github-pat`. Each minute
it rewrites `/conductia/ci-runner/registration-token` when that is missing or
older than 45 minutes (GitHub tokens expire after 1 h); a host reads only that
token, once, to register. Neither parameter is managed by tofu.

Network: own VPC (10.60.0.0/16), one public subnet, no NAT, a security group
with no ingress, no SSH key. Shell access is SSM Session Manager. IMDSv2 with
hop limit 1, so Docker containers in jobs cannot read the instance role.

Every name fits the operator policy: IAM under `/ci-runner/`, Lambda and
Scheduler `conductia-ci-runner*`, logs `/conductia/ci-runner*` and
`/aws/lambda/conductia-ci-runner*`, SSM `/conductia/ci-runner/*`.

The deploy runner module (`infra/deploy-runner/`, ADR-0028) attaches its
launcher guard, `conductia-deploy-launcher-guard`, to the instance, wake and
scheduler roles: an explicit Deny on changing the deploy launcher. This module
declares no exclusive policy list, so its applies leave that attachment alone;
`tests/ci-runner.tftest.hcl` pins that, and that no fleet policy allows what
the guard denies.

## Runbook

All commands use `AWS_PROFILE=conductia-ci` (the operator role). Unset any
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` exported by your shell profile first.

1. **State bucket (once).**
   ```sh
   cd infra/ci-runner/bootstrap
   tofu init && tofu apply -var aws_account_id=368994863349
   ```
   Keep `bootstrap/terraform.tfstate` with the account records (not in git).

2. **Init the module.**
   ```sh
   cd infra/ci-runner
   tofu init -backend-config=bucket=$(tofu -chdir=bootstrap output -raw state_bucket) \
     -backend-config=region=us-east-1 \
     -backend-config=kms_key_id=$(tofu -chdir=bootstrap output -raw state_kms_key_arn)
   ```

3. **PAT into SSM (by hand; tofu never manages its value).** A fine-grained PAT
   on `Conductia/Conductia` with Administration read/write (registration tokens,
   runner list) and Actions read (queued jobs). Write it to a file with mode 600,
   then:
   ```sh
   aws ssm put-parameter --name /conductia/ci-runner/github-pat --type SecureString \
     --value file:///path/to/pat --overwrite
   shred -u /path/to/pat
   ```
   A trailing newline is trimmed. Only the wake Lambda reads it; within a
   minute of apply it creates `/conductia/ci-runner/registration-token`, which
   booting hosts wait for (up to 5 minutes).

4. **Plan and apply.** `tofu plan -out ci.tfplan && tofu apply ci.tfplan`.
   Instances boot, install (about 5-10 min, see log group `/conductia/ci-runner`,
   stream `<instance-id>/cloud-init`), register as `<instance-id>-<class>`, then
   stop after the idle window.

5. **Verify.** Settings -> Actions -> Runners shows six runners;
   `gh api repos/Conductia/Conductia/actions/runners --jq '.runners[] | [.name,.status,.busy]'`.
   Wake decisions: `aws logs tail /aws/lambda/conductia-ci-runner-wake`.

6. **Route jobs.** The workflows (PR #631) read two repository variables:
   ```sh
   gh variable set CI_RUNNER_HEAVY --body conductia-ci-heavy
   gh variable set CI_RUNNER_LIGHT --body conductia-ci-light
   ```
   Delete them (`gh variable delete ...`) to fall back to GitHub-hosted runners.
   Never run workflows from forks on this fleet: the repository is private;
   keep Settings -> Actions -> "Require approval for all outside collaborators".

## Operations

- **Change an idle window:** edit the class's `idle_minutes` in
  `runner_classes` (5..240) and apply. Tofu only changes the instance tag
  `IdleMinutes`, in place; `idle-stop.sh` reads it through instance-metadata
  tags on every run, so the new window applies within 2 minutes on running
  hosts and at the next boot on stopped ones. The number in `user_data` is only
  the fallback for when the tag cannot be read.
- **Update `idle-stop.sh` on existing hosts:** `user_data` is ignored after
  creation, so a host keeps the script it booted with. After changing
  `templates/idle-stop.sh.tftpl` (and on hosts created before tag reading
  existed), run `AWS_PROFILE=conductia-ci scripts/push-idle-stop.sh`. It installs
  the class's rendered script (output `idle_stop_script_b64`) on every running
  host over SSM and checks the sha256; start stopped hosts first, or rerun after
  their next wake. Done for heavy-1/2 and light-1/2 on 2026-10-20, when
  per-class idle windows replaced the 40-minute script.
- **Pause the fleet:** `tofu apply -var wake_enabled=false`; running hosts still
  stop when idle.
- **Roll the AMI or cloud-init:** `ami` and `user_data` are ignored after
  creation so an update never replaces a runner by surprise. Roll one at a time:
  `tofu apply -replace='aws_instance.runner["light-1"]'`, wait for it online,
  then the next. Remove the old runner entry in GitHub if it lingers offline.
- **Reserved job ports:** cloud-init writes `/etc/sysctl.d/90-ci-runner-ports.conf`
  so outbound connections never take 3000, 4310-4311 or 54320-54329 as a local
  port (a `supabase start` once failed on 54322 that way). Hosts created before
  it get it from `AWS_PROFILE=conductia-ci scripts/push-reserved-ports.sh`.
- **Re-registration:** a registered host never registers again on its own.
  GitHub deletes a self-hosted runner offline for 14 days (or someone removes
  it in Settings); the runner service then fails in `_diag` with a
  removed-runner error. Fix from an SSM session:
  `aws ssm start-session --target <instance-id>`, then
  `sudo /opt/ci-runner/reregister.sh`.
- **Hooks:** each job start and end runs `/opt/ci-runner/clean.sh` (containers,
  all volumes, networks, listeners on 3000/4310/4311, `/tmp/e2e-*`); images,
  the npm cache, Playwright browsers and the tool cache are kept. One line per
  hook in `/var/log/ci-runner-hooks.log` (shipped to stream `<id>/hooks`).
- **Trust boundary:** jobs run with passwordless sudo on a shared host. The host
  holds only a registration token (it can add a runner, nothing else). Use only
  for this private repo; never for workflows triggered by forks.

## Teardown

A launcher admin destroys `infra/deploy-runner/` first, or detaches the guard
from the three roles: IAM deletes no role that still has a managed policy, and
the guard denies a guarded operator detaching it. Then `tofu destroy`, then
remove the runners in GitHub, delete the SSM parameter by hand, and destroy `bootstrap/` only after removing `prevent_destroy` (the state
bucket holds versions).

## Cost (us-east-1 on-demand, Oct 2026 list prices; check before signing)

m6a.xlarge about $0.173/h, m6a.large about $0.086/h. Stopped instances cost only
EBS: 4 x 100 (heavy and burst) + 2 x 60 GiB gp3 about $42/month. Running all six 8 h/day on 22
workdays is about $152/month compute (an upper bound: the 15- and 10-minute
idle windows and burst-last starts keep most hours below it), plus public IPv4 ($0.005/h per running
instance) and CloudWatch logs. The wake Lambda (43k invocations/month) and the
scheduler stay in the free tier.
