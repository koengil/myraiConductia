# Discovery worker on AWS (Ignatious)

How the owner stands up the deal-discovery worker in Ignatious's dedicated AWS
account, from an empty account to a worker image that is built at a recorded
commit, probed from its own task, and proven not to fetch excluded mail. Written
for #344 (parent #261). The worker reads Ignatious's Gmail keylessly through
workload identity federation, behind the #262 mailbox guard and the #263
exclusion policy, and writes to the hosted Supabase project. The module is
`infra/discovery-worker/`; the design of record is the #344 design discussion
(R1 to R21, P1 and P2).

It runs in sixteen steps. Steps 0 to 11 build the account, push the image,
create the stages at zero, sign G0, set up the Google side, make the test persona
a consented user, probe from the task and prove the exclusion. Step 12 ticks the
remaining gates, step 13 starts the worker and rehearses the kill switch before
any real user is allowlisted, step 14 is the kill switch, rotation and rollback,
and step 15 is teardown. The [gate table](#go-live-gates) says what each gate
needs, who signs it and when.

Five facts drive the order and the checks:

- **Nothing runs before the gates.** While `image_digest` is unset, the module
  creates no task definition and no service, so nothing can point at a missing
  image. Once it is set, both services exist at desired count 0, and a plan that
  sets any count above 0 fails unless `start_approved` is set, which only step 13
  does. The `discovery_worker_enabled` flag stays off until step 13.
- **Nothing can use delegation before G0.** G0 is signed at step 7. The
  domain-wide delegation grant and the two workload identity configs come at
  step 8, after it.
- **No secret value enters state, a ticket or this transcript.** OpenTofu
  creates empty secret containers. Every value goes in from a local file with
  `file://`, and every check below prints a version id, a prefix test or a count,
  never a value.
- **No address goes on a command line or into state.** `run-task` commands are
  recorded in CloudTrail and the ECS console. The probe's two test addresses live
  in two SSM parameters the owner creates by hand (OpenTofu would refresh a
  managed parameter's decrypted value into state), and the probe and `once`
  families carry fixed commands that name a tenant id and a domain only.
- **Every use of `deploy` and every change to the detection alerts the owner and
  the CCO.** The alert rules also fire on every legitimate apply, rotation and
  rehearsal, so the owner announces each such window to the CCO beforehand, with
  its start and end. An alert outside an announced window is the signal: go to
  step 14.

Roles in this runbook:

| Who | Does |
|---|---|
| Owner, as **admin** (`<admin profile>`) | `tofu apply`, secret values and the probe parameters, every log read (the log groups are under the worker key, and `deploy` is denied every `kms:` action), the hosted Supabase dashboard, the G8 synthetic events |
| Owner, as **`deploy`** (`<deploy profile>`, set up at step 2) | the image push, the probe and `once` runs, the stop levers (scale to zero, stop every task) and forced redeploys |
| Ignatious admin | the two test accounts, the #342 kit, the domain-wide delegation grant, the allowlist group, the Google side of the kill switch |
| Ignatious CCO | co-signs G0, receives every alert, confirms receipt for G8 |

Conventions: `<angle brackets>` are values you fill in. Commands run from the
repository root. Keep every file named `~/conductia-secrets/…` in a directory
created with `mkdir -m 0700 ~/conductia-secrets`, outside the repository, and
delete each one once its step is verified. Never paste a value, a key or an
address into a ticket, a chat or a log.

## Go-live gates

Each gate is recorded in the deployment record with its evidence, who signed it,
and the date and time. A gate that cannot be evidenced is not ticked, and nothing
after it starts. G0 is signed before any delegation can be used; every other gate
is ticked after the step it assesses.

| Gate | When | Evidence | Signed by |
|---|---|---|---|
| G0 | Step 7, before the delegation grant and before any task can mint a delegated token | The owner confirms the provisional P1 (database credential A) and P2 (classify only), or records the alternative. Read and accepted: the [blast radius](#blast-radius-under-p1--a), with the `deploy` equivalence and the Google domain-wide reach; the egress residuals, including the unblocked raw-IP path (ADR-0020 decision 6); the out-of-list token alert (source: Workspace token audit via Reports, read by the #674 poller under the alert identity, Proposed pending #674's test); the P13 alert option (a) or (b); the registered out-of-scope test account; the global `deal_discovery` change at step 9; the dedicated test deal. | owner **and** Ignatious CCO |
| G1 | Step 12 | #331 merged to `develop`; the recorded build commit contains its merge commit (`git merge-base --is-ancestor`); the build followed step 5 (clean worktree, 40-hex revision label, `<sha>-<n>` tag). | owner |
| G2 | Step 11 | (a) #338 merged and contained in the recorded build commit; the ECR digest equals every family's image (step 6). (b) The Ignatious exclusion policy row exists. (c) The one-allowed-mailbox stop rule held; the `once` run's summary reads `stored 1, fetched 1, excluded 1`; the SQL count of stored items for the persona's source is 1. If any of these cannot be produced, G2 fails and is escalated to the owner and the CCO: there is no partial pass. | owner |
| G3 | Steps 9 and 13.3 | The #262 guard and an opt-in made by each user, signed in as itself. Before step 13.3 the allowlist holds only the test persona; after it, exactly the consenting users plus the persona. The out-of-list token alert's allowlist matches at both points. | owner |
| G4 | Step 12 | The hosted project holds no other bank's real mailbox content, today or before #264 (O6, the P1 condition). | owner |
| G5 | Step 10 | The admin dry read of the worker log group succeeded before the first run. The probe from the probe task is green, exit code 0, with "P05 not run in production (no designated test message)" recorded beside its `SKIPPED` line: P01, P02, P03, P07, P08 and P14 `PASS` (P14: the guard admitted the consented persona with its real owner and the group decision applied); P13 `PASS` on a not-allowlisted refusal; P09 `PASS`, or `UNAVAILABLE` with the G9 inspection; **P10 `PASS` (through the alert identity, #674)**, read from the probe's P10 line because the probe records P10 without gating until #674. Green before and after the DNS Firewall moves to `BLOCK`, and again after the G10 restart. The out-of-list token alert receipt is required before real mail: under G0 option (b), the alert for P13's mint arrived and the CCO confirmed it. | owner |
| G6 | Step 8; the observed ARN at step 10 | The provider shows the account pin and the exact condition with its trailing slash; `check-gcp-policy.ts` passes for the mode in use (again for any mode G7 switches to, and after the G10 restart); both negative exchanges were rejected and the temporary roles deleted; the observed STS ARN is recorded. | owner |
| G7 | Step 10 | Signing mode: P02 `PASS` in `direct`, or the kit rerun with `DWD_SIGN_MODE=self`, G6's policy check rerun for `self`, and the probe green. | owner |
| G8 | Step 12 | Every item of step 12's G8 list: ECS Exec off; `deploy` assumed by the owner's own principal, with MFA or the recorded Identity Center setting; the push under the `kms:*` deny, and every log read made as admin; the DNS Firewall's action `BLOCK`; delivery to the owner **and** the CCO of the real events, a deliberate EventBridge rule change, a sample GuardDuty finding, a synthetic DNS Firewall hit, the one approved override run, stopped by `deploy` with `stop-task` while still listed (`describe-tasks`: `STOPPED`, `g8-stop-test`, `UserInitiated`; the `StopTask` CloudTrail event id recorded), and the out-of-list token alert (its receipt gates real mail). | owner **and** CCO (receipt) |
| G9 | Step 12 | The #342 GCP-side gates (locked sink, alerts, CCO viewer, holders attested, legacy delegation rows cleared), and the delegation inspection: exactly one entry, `sa-dwd`'s client id, scope exactly `gmail.readonly`, `sa-directory` absent. | Ignatious admin, owner |
| G10 | Step 13.2, before any real user is allowlisted | The kill switch rehearsed once on the test persona, each lever timed (lever 2: every task ARN it stopped reads `STOPPED` in `describe-tasks` after `wait tasks-stopped`, and a list after the wait is empty), and the token tail recorded as an upper bound (step 13.2). | owner |
| G11 | Before AI is turned on for any real mail (any model call on mailbox-derived content) | `npm run ai:zdr-probe` exits 0 with `AI_GATEWAY_API_KEY` set to the production key in the environment, never typed on the command line: (a) the screen model answers 200 with zero data retention on; (b) a request with ZDR on and no provider restriction, to a model no ZDR provider serves (default `zai/glm-4.6`), answers 400 `no_providers_available`; a 403 `permission_denied` means the key's team plan has no ZDR. The two printed lines are recorded. A failure keeps AI off; it is not retried with another key, path or provider (ADR-0017 decision 6, the gateway row). | owner |

## 0. Owner inputs (human step)

Collect these before anything is created. Record them in the deployment record
(the owner's own document, never the repository), which G0 and every later gate
cite.

| Input | Source | Goes to |
|---|---|---|
| Account id and region (default `us-east-1`) | O1 (P3) | tfvars `aws_account_id`, `region` |
| Who holds root and the admin role; who runs `tofu apply` as which role | O1 | the deployment record (root and admin are break-glass) |
| The owner's principal type, `iam_user` or `sso`, and the named principals that may assume `deploy` | O1 | tfvars `deploy_principal_type`, `deploy_trusted_principal_arns` |
| Under `sso`: the permission set's Identity Center MFA setting and session duration (1 hour at most) | O1 | the deployment record (G8 item 2) |
| Any GuardDuty detector already in the region | O1 | tfvars `guardduty_detector_id` (only if one exists) |
| Only for a region missing from the module's GuardDuty agent table (`detection.tf`): the Fargate agent's repository ARN | the GuardDuty user guide | tfvars `guardduty_agent_repository_arn` (the plan refuses without it) |
| The owner's and the CCO's alert addresses | O4 | tfvars `alarm_email`, `cco_alarm_email` (sensitive: no plan prints them) |
| The hosted Supabase project URL and its project ref | owner | tfvars `supabase_url`; steps 3, 4, 9 |
| The Ignatious tenant id and Workspace domain | owner | tfvars `probe_tenant_id`, `probe_workspace_domain` |
| Ignatious's GCP project id, project number and organisation id | P9 | the #342 kit at step 8 |
| Two dedicated test accounts in Ignatious's domain | O8 | the two SSM parameters at step 3; the G0 record |

The two test accounts are created by Ignatious's admin, in Ignatious's
Workspace, for this purpose only:

- **The test persona** (for example `conductia-probe@<domain>`). It becomes a
  real, consented, allowlisted user of the tenant at step 9, and it is the only
  mailbox the probe, the exclusion check and the G10 rehearsal ever name.
- **The out-of-scope test account.** P13 mints a token for it and discards it
  unused. It is never allowlisted, never invited, never a Conductia user in any
  tenant, never a mailbox source of the tenant, and the probe refuses it
  otherwise (`out_of_scope_not_registered`).

No real user's mailbox is ever named to the probe.

Write the tfvars file. It names the account and the alert addresses, so it stays
out of git (`.gitignore`: `infra/**/*.tfvars`):

```hcl
# infra/discovery-worker/ignatious.tfvars
aws_account_id         = "<account id>"
region                 = "<region>"
supabase_url           = "https://<project ref>.supabase.co"
probe_tenant_id        = "<Ignatious tenant id>"
probe_workspace_domain = "<workspace domain>"
alarm_email            = "<owner alert address>"
cco_alarm_email        = "<CCO alert address>"

# Who may assume deploy (O1). iam_user: the named users,
#   ["arn:aws:iam::<account id>:user/<name>"]
# sso: the permission set's reserved role pattern,
#   ["arn:aws:iam::<account id>:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_<permission set>_*"]
deploy_principal_type         = "<iam_user or sso>"
deploy_trusted_principal_arns = ["<principal ARN or pattern>"]

# Only if O1 reports a detector already in the region:
# guardduty_detector_id = "<detector id>"

# image_digest is added at step 6. dns_firewall_action keeps its default, ALERT,
# until step 10. The desired counts and start_approved keep their defaults
# (nothing runs) until step 13.
```

Verify: `git check-ignore infra/discovery-worker/ignatious.tfvars` prints the
path; Ignatious's admin confirms both test accounts exist (Admin console ›
Directory › Users) and that neither is in the allowlist group.

## 1. Bootstrap the state bucket

As admin. This creates the versioned, KMS-encrypted, public-access-blocked bucket
the main module keeps its state in. It runs once, with local state.

```bash
export AWS_PROFILE=<admin profile> AWS_REGION=<region>
aws sts get-caller-identity --query Account --output text      # must print <account id>
tofu -chdir=infra/discovery-worker/bootstrap init
tofu -chdir=infra/discovery-worker/bootstrap apply \
  -var aws_account_id=<account id> -var region=<region>
tofu -chdir=infra/discovery-worker/bootstrap output
```

Keep `infra/discovery-worker/bootstrap/terraform.tfstate` with the deployment
record. It is git-ignored and describes only the bucket and its key.

Dashboard: S3 › Buckets › `conductia-discovery-worker-tfstate-<account id>` ›
Properties (Bucket Versioning: Enabled; Default encryption: SSE-KMS) and
Permissions (Block all public access: On).

Verify: `aws s3api get-bucket-versioning --bucket conductia-discovery-worker-tfstate-<account id>`
prints `Enabled`, and `aws s3api get-public-access-block --bucket conductia-discovery-worker-tfstate-<account id>`
shows all four settings `true`.

## 2. Stage 1: everything that runs no code

As admin, with `image_digest` unset. Announce the apply window to the CCO
first: this apply creates the alert rules, and from then on every apply fires
them. It creates:

- the network (no ingress, one NAT gateway), the worker key, the image
  repository, the task and execution roles, the secret containers and the worker
  log group (no SSM parameter: the owner creates the two at step 3);
- the `deploy` role, trusted as `deploy_principal_type` says, for one hour at a
  time;
- the trail (every region, log-file validation, its own key and bucket), the VPC
  flow logs, the Resolver query logs, the DNS Firewall in `ALERT`, and GuardDuty
  with Fargate runtime monitoring;
- the alert topic with the owner's and the CCO's subscriptions (and the same pair
  on a us-east-1 topic for the global-service rules when the region is
  elsewhere), the alert rules, and the sync-failure, address and DNS Firewall
  alarms.

It creates no task definition and no service.

```bash
tofu -chdir=infra/discovery-worker init \
  -backend-config=bucket=conductia-discovery-worker-tfstate-<account id> \
  -backend-config=region=<region> \
  -backend-config=kms_key_id=<state_kms_key_arn from step 1>
tofu -chdir=infra/discovery-worker plan -var-file=ignatious.tfvars -out=stage1.tfplan
tofu -chdir=infra/discovery-worker show -json stage1.tfplan \
  | jq -r '.resource_changes[].type' | sort | uniq -c
tofu -chdir=infra/discovery-worker apply stage1.tfplan
rm infra/discovery-worker/stage1.tfplan
tofu -chdir=infra/discovery-worker output
```

The type count must show no `aws_ecs_task_definition` and no `aws_ecs_service`,
and it must show `aws_cloudtrail`, `aws_flow_log`, `aws_guardduty_detector_feature`,
two `aws_route53_resolver_firewall_rule` and two `aws_sns_topic_subscription`
(four outside us-east-1). If it shows a task definition or a service, stop:
`image_digest` is set too early. Keep the outputs: the later steps use
`ecr_repository_url`, `private_subnet_ids`, `security_group_id`,
`run_task_network_configuration`, `task_role_arn`, `deploy_role_arn`,
`alert_topic_arn`, `global_alert_topic_arn`, `dns_firewall_rule_group_id`,
`dns_query_log_group_name` and `guardduty_detector_id`.

Then:

1. **(human step)** The owner and the CCO each confirm the "Subscription
   Confirmation" mail of every alert topic (one, or two outside us-east-1). Until
   both have, an alert reaches no one.
2. Set up the `deploy` profile in your `~/.aws/config`. It is the
   `<deploy profile>` of every later step. Under `iam_user`:

   ```ini
   [profile conductia-deploy]
   role_arn = <deploy_role_arn>
   source_profile = <your IAM user profile>
   mfa_serial = arn:aws:iam::<account id>:mfa/<your MFA device>
   duration_seconds = 3600
   region = <region>
   ```

   Under `sso`, the same without `mfa_serial`, with `source_profile` your
   Identity Center profile. The MFA is Identity Center's: the trust policy cannot
   see it through a chained role, so the deployment record holds the permission
   set's MFA setting instead (a documented deviation, G8 item 2).
3. Assume it once:

   ```bash
   aws sts get-caller-identity --profile conductia-deploy --query Arn --output text
   ```

   It prints `arn:aws:sts::<account id>:assumed-role/conductia-discovery-worker-deploy/…`,
   and the owner and the CCO each receive the `deploy-role-assumed` alert. Record
   both receipts: it is the first G8 delivery check.

Dashboard: ECS › Clusters › `conductia-discovery` (0 services, 0 tasks); ECR ›
Repositories › `conductia-discovery-worker` (Tag immutability: Enabled, Scan on
push: Enabled, Encryption: KMS); VPC › Route 53 Resolver › DNS Firewall › Rule
groups › `conductia-discovery-worker` (associated with the VPC); GuardDuty ›
Runtime Monitoring (AWS Fargate (ECS only): Enabled, automated agent
configuration: Enabled).

```bash
aws sns list-subscriptions-by-topic --topic-arn <alert_topic_arn> --query 'Subscriptions[].SubscriptionArn'
aws cloudtrail get-trail-status --name conductia-discovery-worker --query IsLogging
aws route53resolver list-firewall-rules --firewall-rule-group-id <dns_firewall_rule_group_id> \
  --query 'FirewallRules[].[Name,Action]' --output text
aws guardduty get-detector --detector-id <guardduty_detector_id> \
  --query "Features[?Name=='RUNTIME_MONITORING'].Status" --output text
```

The subscription query prints ARNs only, never the addresses. Outside us-east-1,
run it again with `--region us-east-1 --topic-arn <global_alert_topic_arn>`.

Verify: `aws ecs list-task-definitions --family-prefix conductia-discovery` and
`aws ecs list-services --cluster conductia-discovery` both print empty lists;
`aws secretsmanager list-secret-version-ids --secret-id discovery-queue-database-url --query 'Versions[].VersionStages'`
prints `[]`; every topic shows two subscription ARNs and no `PendingConfirmation`;
the trail is logging (`true`); the firewall rules read `allow-the-allowlist ALLOW`
and `everything-else ALERT`; runtime monitoring reads `ENABLED`; and both
recipients received the `deploy-role-assumed` alert.

## 3. The worker's Supabase key and the probe parameters

As admin (`export AWS_PROFILE=<admin profile>`). The key goes in first, then the
two test addresses.

1. **(human step)** In the hosted project's dashboard (Project Settings › API
   Keys › Secret keys), create a secret key named `discovery-worker-aws` (P1 = A).
   It is this worker's alone, so deleting it cuts the worker's REST access
   without touching any other key. Paste it into
   `~/conductia-secrets/worker-key` with an editor, never on a command line.
2. Strip any line break and check the prefix without printing the value. The
   worker refuses a legacy JWT `service_role` key in production, because
   deleting a secret key does not revoke it:

   ```bash
   umask 077
   tr -d '\r\n' < ~/conductia-secrets/worker-key > ~/conductia-secrets/worker-key.clean
   test "$(head -c 10 ~/conductia-secrets/worker-key.clean)" = sb_secret_ && echo "prefix ok" || echo "STOP: not an sb_secret_ key"
   aws secretsmanager put-secret-value --secret-id supabase-worker-secret-key \
     --secret-string file://$HOME/conductia-secrets/worker-key.clean --query VersionId --output text
   rm ~/conductia-secrets/worker-key ~/conductia-secrets/worker-key.clean
   ```

   If the prefix check prints `STOP`, do not put the value.
3. Create the two probe parameters, each a `SecureString` under the worker key
   (the `kms_key_arn` output). Each address goes in from a file holding it alone,
   so it is never an argument:

   ```bash
   aws ssm put-parameter --name /conductia/discovery-worker/probe/mailbox --type SecureString \
     --key-id <kms_key_arn> --value file://$HOME/conductia-secrets/probe-mailbox --query Version --output text
   aws ssm put-parameter --name /conductia/discovery-worker/probe/out-of-scope --type SecureString \
     --key-id <kms_key_arn> --value file://$HOME/conductia-secrets/probe-out-of-scope --query Version --output text
   rm ~/conductia-secrets/probe-mailbox ~/conductia-secrets/probe-out-of-scope
   ```

   OpenTofu does not manage these parameters: the module names them by their
   ARNs in the probe family and the execution role's policy, and a managed
   parameter would be refreshed into state with its decrypted value. So no
   address enters state, and teardown deletes them by hand (step 15). The
   execution role can decrypt them only because they are under the worker key.
4. Put the message index's digest key (#461, D93): a random value the worker
   derives each tenant's HMAC key from. It is generated into a file and never
   printed. Keep no copy: a lost key only makes the next read re-process and
   re-key the index.

   ```bash
   umask 077
   openssl rand -hex 32 | tr -d '\r\n' > ~/conductia-secrets/index-digest-key
   aws secretsmanager put-secret-value --secret-id discovery-index-digest-key \
     --secret-string file://$HOME/conductia-secrets/index-digest-key --query VersionId --output text
   rm ~/conductia-secrets/index-digest-key
   ```

Each `put-secret-value` pages the owner and the CCO (`secret-changed`), and each
`put-parameter` under the probe prefix pages them too (`probe-parameter-changed`),
inside the announced window.

Verify: `aws secretsmanager list-secret-version-ids --secret-id supabase-worker-secret-key --query 'Versions[].VersionStages'`
shows one `AWSCURRENT`, and
`aws ssm describe-parameters --parameter-filters Key=Name,Values=/conductia/discovery-worker/probe/mailbox,/conductia/discovery-worker/probe/out-of-scope --query 'Parameters[].[Name,Type,KeyId]' --output text`
(no value is read) lists both, each `SecureString` with the worker key's ARN or
alias.

## 4. Hosted database check and the queue credential

As the owner, in the hosted project's SQL editor (as `postgres`, the dashboard
role). These queries read state and counts only.

```sql
select version from supabase_migrations.schema_migrations
 where version between '20260925120000' and '20261002183000' order by 1;
select rolname, rolcanlogin, rolconnlimit, rolconfig from pg_roles where rolname = 'discovery_queue';
select to_regclass('pgboss.version') is not null as pgboss_installed,
       (select version from pgboss.version) as pgboss_version;
select key, enabled from feature_flags where key in ('deal_discovery', 'discovery_worker_enabled');
select pg_has_role('postgres', 'pg_signal_backend', 'member') as can_terminate_queue_sessions;
```

- Every discovery migration on `develop` in that range is listed, and so are the
  #338 exclusion migrations once #338 is merged (`20261003110000` and later).
- `discovery_queue` exists, can log in, and has its connection limit and
  `search_path = pgboss`.
- `pgboss_installed` is true.
- `discovery_worker_enabled` is **false**. It stays false until step 13. Record
  the current value of `deal_discovery`.
- `can_terminate_queue_sessions` is true. Kill-switch lever 4 (rotate the queue
  password, then terminate its sessions) depends on it.

Then the queue credential:

1. Generate a password of letters and digits:

   ```bash
   umask 077
   openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 40 > ~/conductia-secrets/queue-password
   ```

2. **(human step)** In the SQL editor, run
   `alter role discovery_queue with password '<the generated password>';`,
   pasting the password from the file.
3. Build the session-pooler URL (dashboard: Connect › Session pooler; the user is
   `discovery_queue.<project ref>`) into a file, and check that the pooler
   accepts the role. The check reads nothing:

   ```bash
   printf 'postgresql://discovery_queue.%s:%s@%s:5432/postgres' \
     '<project ref>' "$(cat ~/conductia-secrets/queue-password)" '<session pooler host>' \
     > ~/conductia-secrets/queue-url
   psql "$(cat ~/conductia-secrets/queue-url)" -Atc 'select current_user'      # prints discovery_queue
   aws secretsmanager put-secret-value --secret-id discovery-queue-database-url \
     --secret-string file://$HOME/conductia-secrets/queue-url --query VersionId --output text
   rm ~/conductia-secrets/queue-password ~/conductia-secrets/queue-url
   ```

If the pooler refuses the role, stop. The only fallback is the `postgres` URL,
which can write every table, and the worker never holds it (P1).

Verify: the five queries read as above, `psql` printed `discovery_queue`, and
`aws secretsmanager list-secret-version-ids --secret-id discovery-queue-database-url --query 'Versions[].VersionStages'`
shows one `AWSCURRENT`.

## 5. Build and push the image at a recorded commit

Preconditions: #331 and #338 are merged to `develop`. If either is not, stop.
The image that reaches real mail must contain both, and G1 and G2 check it.

1. A clean checkout of the recorded `develop` commit:

   ```bash
   git fetch origin
   sha=$(git rev-parse origin/develop)
   git merge-base --is-ancestor <#331 merge commit> "$sha" && echo "#331 in"
   git merge-base --is-ancestor <#338 merge commit> "$sha" && echo "#338 in"
   git worktree add "/tmp/conductia-build-$sha" "$sha"
   test -z "$(git -C "/tmp/conductia-build-$sha" status --porcelain)" && echo "clean" || echo "STOP: not clean"
   ```

2. Build with the revision read from that checkout, never typed. The Dockerfile
   refuses any `GIT_SHA` that is not 40 lowercase hex and labels the image with
   it. The tag is `<sha>-<n>`, `n` starting at 1; tags are immutable, so a
   rebuild of the same commit takes the next `n`:

   ```bash
   GIT_SHA=$(git -C "/tmp/conductia-build-$sha" rev-parse HEAD)
   tag="$GIT_SHA-1"
   docker build --platform linux/amd64 --build-arg GIT_SHA="$GIT_SHA" \
     -f "/tmp/conductia-build-$sha/worker/Dockerfile" -t "conductia-discovery-worker:$tag" "/tmp/conductia-build-$sha"
   docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "conductia-discovery-worker:$tag"
   ```

   The label must equal `$GIT_SHA`. Use `--platform linux/arm64` only if
   `cpu_architecture = "ARM64"`.
3. Push as `deploy`, with the repository URL from step 2's outputs:

   ```bash
   export AWS_PROFILE=<deploy profile>
   aws ecr get-login-password | docker login --username AWS --password-stdin <account id>.dkr.ecr.<region>.amazonaws.com
   docker tag "conductia-discovery-worker:$tag" "<ecr_repository_url>:$tag"
   docker push "<ecr_repository_url>:$tag"
   aws ecr describe-images --repository-name conductia-discovery-worker --image-ids imageTag="$tag" \
     --query 'imageDetails[0].imageDigest' --output text
   docker logout <account id>.dkr.ecr.<region>.amazonaws.com
   git worktree remove "/tmp/conductia-build-$sha"
   ```

4. Record together, in the deployment record: the commit, the tag, the digest ECR
   reports and the label. G1 and G2 read them.

The push runs under `deploy`'s `kms:*` deny: ECR encrypts through the grant it
made when the repository was created. A successful push is G8 item 3, and this
assumption of `deploy` is one of the G8 item 2 records.

**Rebuild rule.** Any change to what G1, G2 or the probe assessed (a merge the
gates depend on, a worker fix, a Dockerfile change) means a new build at a new
commit or `n`, then step 6 again, the probe (step 10) and the exclusion check
(step 11). A digest no gate has seen never runs on real mail.

Dashboard: ECR › Repositories › `conductia-discovery-worker` › Images: the tag,
its digest and its scan status.

Verify: `aws ecr describe-image-scan-findings --repository-name conductia-discovery-worker --image-id imageTag=<tag> --query 'imageScanFindings.findingSeverityCounts'`
returns (record the counts), and the recorded digest, tag, commit and label agree.

## 6. Stage 2 at zero

As admin. Precondition: the Supabase key, the queue URL and the index digest key each
hold a current version, or a task would start without them:

```bash
export AWS_PROFILE=<admin profile>
aws secretsmanager list-secret-version-ids --secret-id supabase-worker-secret-key --query 'Versions[].VersionStages'
aws secretsmanager list-secret-version-ids --secret-id discovery-queue-database-url --query 'Versions[].VersionStages'
aws secretsmanager list-secret-version-ids --secret-id discovery-index-digest-key --query 'Versions[].VersionStages'
```

All three must show `AWSCURRENT`. Then add the digest from step 5 to the tfvars file
and apply. This registers the five families (`conductia-discovery-classify`,
`-extract`, `-probe`, `-once`, `-estimate`) and creates both services at desired count 0:

```hcl
image_digest = "sha256:<64 hex from step 5>"
```

```bash
tofu -chdir=infra/discovery-worker plan -var-file=ignatious.tfvars -out=stage2.tfplan
tofu -chdir=infra/discovery-worker apply stage2.tfplan
rm infra/discovery-worker/stage2.tfplan
tofu -chdir=infra/discovery-worker output task_images
```

Check that the digest ECR reports and the image of every registered family are
the same `<ecr_repository_url>@sha256:<digest>`:

```bash
for family in classify extract probe once estimate; do
  aws ecs describe-task-definition --task-definition "conductia-discovery-$family" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text
done
```

The two workload identity secrets are still empty here, so no task could mint a
Google token even if one ran. The five `RegisterTaskDefinition` events page the
owner and the CCO (`ecs-operation`): the first real ECS events G8 item 5 counts.

Dashboard: ECS › Clusters › `conductia-discovery` › Services: both services,
Desired tasks 0, Running tasks 0.

Verify: the five images equal the recorded digest, and
`aws ecs describe-services --cluster conductia-discovery --services conductia-discovery-classify conductia-discovery-extract --query 'services[].[serviceName,desiredCount,runningCount]'`
prints 0 and 0 for both.

## 7. G0: the owner and Ignatious's CCO sign (human step)

G0 is signed now, before any delegation exists: no domain-wide delegation grant,
empty workload identity secrets, and no task able to mint a delegated token.
Both the owner and Ignatious's CCO sign it, with the date, in the deployment
record. They read and accept:

1. The provisional P1 (database credential A: the `discovery-worker-aws` secret
   key plus the `discovery_queue` login, and no owner or service-role Postgres
   URL) and P2 (classify only; extract stays at desired count 0, on recorded
   replies, until the model processor terms are verified). Or they record the
   alternative.
2. The [blast radius under P1 = A](#blast-radius-under-p1--a), including that
   domain-wide delegation lets a compromised task mint `gmail.readonly` for every
   mailbox in the domain, that holding `deploy` equals holding the secrets and
   the Gmail identity, and the `UpdateService` scale-up residual.
3. The egress residuals in the same section, including the raw-IP path: a connection to an IP literal is not blocked, only seen in flow logs (ADR-0020 decision 6).
4. The out-of-list token alert: an alert on any delegated token whose mailbox is
   not in the allowlist. One name, one source, one owner. Source: the Workspace
   token audit for the delegation client id, read through "Reports: Read" by the
   #674 poller under the alert identity. Dan Dima-ala (Ignatious) chose to grant
   Reports on 2026-10-20 (written access approval, Slack). The identity holding
   Reports is **Proposed** (Guillermo, owner, 2026-10-21): a separate alert
   identity the worker cannot mint for, not `sa-directory`; it is open until
   #674's test passes. Owner of the alert and its allowlist: to be set in #674.
   We believe Google Cloud's audit logs name the principal that minted a token,
   not the mailbox (unverified: no source in this repo states it; P11 is the
   check that settles it). This alert is
   built before real mail, and P10 `PASS` with the alert receipt gates real mail
   (G5, G8).
5. The P13 alert option. P13 mints a token for the out-of-scope test account, so
   by default it fires that alert. Record (a) exclude exactly that one `sub` from
   the alert filter, or (b) announce every probe window to the CCO and keep the
   alert firing. (b) is recommended: the filter stays a pure allowlist.
6. The out-of-scope test account, registered here as the one P13 may name.
7. That `deal_discovery` is a global flag. Turning it on at step 9 affects every
   tenant in the hosted project, not only Ignatious.
8. That a dedicated test deal exists for the persona (step 9): the opt-in is open
   only to the MD or deal team of a deal, and the persona is never put on a real
   deal.

Verify: the G0 record carries both signatures and the date; Ignatious's admin
confirms Admin console › Security › Access and data control › API controls ›
Manage Domain Wide Delegation holds no entry for this service account yet; and
`aws secretsmanager list-secret-version-ids --secret-id google-wif-dwd-config --query 'Versions[].VersionStages'`
prints `[]`.

## 8. The Google side: kit, delegation grant, workload identity, federation check

Only after G0.

1. **(human step, Ignatious admin)** Run the #342 kit's production profile with
   `TASK_ROLE_NAME=conductia-discovery-worker` (the `task_role_name` output),
   `AWS_ACCOUNT_ID=<account id>` and `DWD_SIGN_MODE=direct`, following the kit's
   README. It creates `sa-dwd`, `sa-directory`, the pool `conductia-worker` and the
   provider `aws-ecs`, and writes two keyless configs:
   `conductia-worker-wif-dwd.json` and `conductia-worker-wif-directory.json`.
2. **(human step, Ignatious admin)** Grant domain-wide delegation, now and not
   before: Admin console › Security › Access and data control › API controls ›
   Manage Domain Wide Delegation › Add new. Client ID: `sa-dwd`'s numeric client
   id. Scope: exactly `https://www.googleapis.com/auth/gmail.readonly`.
3. As admin, put both configs into their secrets. They are not secrets, but they
   are tamper-sensitive (audience, impersonation URL). First check that neither
   holds key material:

   ```bash
   grep -c private_key conductia-worker-wif-dwd.json conductia-worker-wif-directory.json   # 0 and 0
   jq -r .type conductia-worker-wif-dwd.json conductia-worker-wif-directory.json          # external_account twice
   aws secretsmanager put-secret-value --secret-id google-wif-dwd-config \
     --secret-string file://conductia-worker-wif-dwd.json --query VersionId --output text
   aws secretsmanager put-secret-value --secret-id google-wif-directory-config \
     --secret-string file://conductia-worker-wif-directory.json --query VersionId --output text
   ```

4. Federation check (G6). The provider must be pinned to the account, with the
   exact condition and its trailing slash, which stops a prefix-sharing role
   such as `conductia-discovery-worker2` from matching:

   ```bash
   gcloud iam workload-identity-pools providers describe aws-ecs --workload-identity-pool=conductia-worker \
     --location=global --project=<gcp project> --format='yaml(aws.accountId,attributeCondition,attributeMapping)'
   ```

   `aws.accountId` is `<account id>`, and `attributeCondition` is exactly
   `assertion.arn.startsWith('arn:aws:sts::<account id>:assumed-role/conductia-discovery-worker/')`.
5. The service accounts' policies must hold exactly the entries design R7 allows
   for the mode in use, and nothing else (no `roles/iam.serviceAccountTokenCreator`
   anywhere; `signJwtOnly` is a custom role holding only
   `iam.serviceAccounts.signJwt`):

   ```bash
   gcloud iam service-accounts get-iam-policy <sa-dwd email> --project=<gcp project> --format=json > ~/conductia-secrets/sa-dwd-policy.json
   gcloud iam service-accounts get-iam-policy <sa-directory email> --project=<gcp project> --format=json > ~/conductia-secrets/sa-directory-policy.json
   gcloud iam roles describe signJwtOnly --project=<gcp project> --format=json > ~/conductia-secrets/sign-role.json
   node --import tsx scripts/infra/check-gcp-policy.ts --mode direct \
     --principal-set 'principalSet://iam.googleapis.com/projects/<gcp project number>/locations/global/workloadIdentityPools/conductia-worker/attribute.aws_role/arn:aws:sts::<account id>:assumed-role/conductia-discovery-worker' \
     --sa-dwd ~/conductia-secrets/sa-dwd-policy.json --sa-directory ~/conductia-secrets/sa-directory-policy.json \
     --sign-role projects/<gcp project>/roles/signJwtOnly --sign-role-definition ~/conductia-secrets/sign-role.json
   ```

   It prints roles and member kinds only and ends `PASS`. If G7 later switches to
   `self`, rerun it with `--mode self --sa-dwd-email <sa-dwd email>` before the new
   config is put.
6. Negative exchanges (A3). As admin, create two temporary roles that trust your
   own principal: `conductia-negative-test` (an unrelated name) and
   `conductia-discovery-worker2` (a prefix-sharing name). From CloudShell, assume
   each, then try the token exchange with the DWD config:

   ```bash
   eval "$(aws sts assume-role --role-arn arn:aws:iam::<account id>:role/conductia-discovery-worker2 \
     --role-session-name negative-test --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text \
     | awk '{print "export AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" AWS_SESSION_TOKEN="$3}')"
   gcloud auth login --cred-file=conductia-worker-wif-dwd.json --quiet && gcloud auth print-access-token >/dev/null
   unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
   ```

   Both exchanges must be rejected by the attribute condition. Then delete both
   roles and revoke the CloudShell gcloud login (`gcloud auth revoke --all`).

Verify: `list-secret-version-ids` shows one `AWSCURRENT` for
`google-wif-dwd-config` and for `google-wif-directory-config`; the provider
output and the policy check's `PASS` are in the deployment record; both negative
exchanges were rejected; and `aws iam get-role --role-name conductia-discovery-worker2`
and the same for `conductia-negative-test` each fail with `NoSuchEntity`.

## 9. The test persona becomes a consented user

The probe's P14 must find a real, consented, allowlisted persona, with its own
source. Opt-in is made by the user, signed in as itself
(`mailbox_consent_grant` takes `auth.uid()`), so the owner cannot consent for it.

1. **(human step)** A dedicated test deal: in the Ignatious firm, create a deal
   used for nothing else (for example the code name `Probe`). Never use a real
   deal: the persona sees what its deals see.
2. **(human step)** Invite the persona into the Ignatious firm from that deal's
   Team page, on its deal team. The persona accepts and holds a seat. The opt-in
   is open only to the MD and the deal team of a deal.
3. Write the Google registration with the persona's source, from the admin
   machine, with a short-lived key used for this one step (O10). The worker's key
   never leaves Secrets Manager.
   - **(human step)** Create a secret key named `registration-bootstrap` in the
     dashboard and paste it into `~/conductia-secrets/registration-key`.
   - The config is `.secrets/google/registration.json` (git-ignored): the tenant,
     domain, `sa-dwd` and `sa-directory` emails, the delegation client id, the
     allowlist group, the firm company, `"status": "active"`, `consentedAt`, and
     `"sources": [{ "address": "<persona address>", "ownerEmail": "<persona address>" }]`.

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://<project ref>.supabase.co \
   SUPABASE_SECRET_KEY="$(tr -d '\r\n' < ~/conductia-secrets/registration-key)" \
     node --import tsx scripts/google/write-registration.ts --config .secrets/google/registration.json >/dev/null \
     && echo "registration written"
   ```

   Its standard output (the row and the source address) is discarded, so nothing
   is copied from the terminal. Then delete the `registration-bootstrap` key in
   the dashboard and prove it is gone:

   The key goes into a 0600 header file, which `curl` reads with `-H @file`, so
   it is never on a command line:

   ```bash
   umask 077
   { printf 'apikey: '; tr -d '\r\n' < ~/conductia-secrets/registration-key; printf '\n'; } \
     > ~/conductia-secrets/registration-header
   curl -s -o /dev/null -w '%{http_code}\n' -H @$HOME/conductia-secrets/registration-header \
     'https://<project ref>.supabase.co/rest/v1/feature_flags?select=key&limit=1'      # 401
   rm ~/conductia-secrets/registration-key ~/conductia-secrets/registration-header
   ```

4. Turn `deal_discovery` on, in the SQL editor. This is the global change G0
   accepted (item 7); record the time. `discovery_worker_enabled` stays off.

   ```sql
   update feature_flags set enabled = true where key = 'deal_discovery';
   ```

   The opt-in (`POST /api/v1/discovery/mailbox-consent`) is behind this flag.
5. **(human step)** The persona signs in to Conductia as itself, opens Profile ›
   Deal discovery, ticks the agreement and selects **Connect my mailbox**.
6. **(human step, Ignatious admin)** Add the persona to the allowlist group.
   Group membership is proven by P14 at step 10, not here.

Verify: in the SQL editor, with counts only, every count is 1. If any is not,
stop.

```sql
select count(*) as google_mailbox_sources from content_sources
 where tenant_id = '<tenant id>' and kind = 'mailbox' and provider = 'google'
   and status = 'active' and archived_at is null;
select count(*) as allowed_rows from allowed_mailboxes
 where tenant_id = '<tenant id>' and provider = 'google';
select count(*) as open_consents from mailbox_consents
 where tenant_id = '<tenant id>' and withdrawn_at is null;
select count(*) as sources_owned_by_the_allowed_user from content_sources s
  join allowed_mailboxes a on a.tenant_id = s.tenant_id and a.address = lower(s.address) and a.provider = 'google'
 where s.tenant_id = '<tenant id>' and s.kind = 'mailbox' and s.provider = 'google'
   and s.owner_user_id = a.user_id;
```

Record the persona's user id and source id (`select user_id from allowed_mailboxes where tenant_id = '<tenant id>'`
and `select id from content_sources where tenant_id = '<tenant id>' and kind = 'mailbox' and provider = 'google'`)
for step 11.

## 10. The probe from the task (G5)

The probe runs from its own family: the classify image, roles, network,
environment and secrets, plus the two test addresses from SSM. Its command is
fixed in the task definition
(`probe --live --confirm-domain <domain> --tenant <tenant id> --allow-remote-db --out /tmp/probe`),
so it runs with no command override. It asks the #262 guard for the persona, with
the persona's owner and the group decision bound, before any request that names
the mailbox (P14). Its group read records allowlist drift exactly as the worker
does. It reads no message: P03 reads the mailbox profile only, and P05 reads a raw
message only when given a designated, seeded test message id
(`PROBE_RAW_TEST_MESSAGE_ID`), which the probe family never injects. So from the
task P05 is `SKIPPED` and no message the exclusion policy has not judged is ever
fetched.

Every log read in this step and later is made as admin: the log groups are under
the worker key, and `deploy` is denied every `kms:` action.

1. **(human step)** Under G0 option (b), announce the probe window to the CCO.
2. The dry read (G5). Before the first run, as admin, read the worker log group:

   ```bash
   aws logs filter-log-events --profile <admin profile> --log-group-name /conductia/discovery-worker \
     --limit 1 --query 'length(events)'
   ```

   It prints `0` with no `AccessDeniedException`. If the read is refused, fix
   that first: a run whose log cannot be read cannot be evidenced.
3. As `deploy`, run it and wait for it to stop, then read its log as admin:

   ```bash
   export AWS_PROFILE=<deploy profile>
   aws ecs run-task --cluster conductia-discovery --task-definition conductia-discovery-probe \
     --launch-type FARGATE --count 1 \
     --network-configuration 'awsvpcConfiguration={subnets=[<private subnet a>,<private subnet b>],securityGroups=[<security group id>],assignPublicIp=DISABLED}' \
     --query 'tasks[0].taskArn' --output text
   aws ecs wait tasks-stopped --cluster conductia-discovery --tasks <task arn>
   aws ecs describe-tasks --cluster conductia-discovery --tasks <task arn> \
     --query 'tasks[0].[stoppedReason,containers[0].exitCode]'
   aws logs get-log-events --log-group-name /conductia/discovery-worker --profile <admin profile> \
     --log-stream-name probe/worker/<task id> --query 'events[].message' --output text
   ```

   The `--network-configuration` value is the `run_task_network_configuration`
   output, verbatim. The task id is the last segment of the task ARN.
4. Read the result. Green means all of:
   - the exit code is 0, and no `{"evt":"probe_error",…}` line. The probe exits 1
     when any required check (P01, P02, P03, P07, P08, P09, P12, P13, P14) is
     not `PASS`: a `FAIL`, or an inconclusive `PENDING`, `SKIPPED` or
     `UNAVAILABLE`. The two documented exceptions are P09 `UNAVAILABLE` (below)
     and P12 `UNAVAILABLE` (no drive probe account in production);
   - P01, P02, P03, P07, P08 and **P14** read `PASS`. P14 means the guard admitted
     the consented persona with its real owner and the group decision applied;
   - **P13 reads `PASS`**, on a not-allowlisted refusal. A P13 `PENDING` (an
     empty `PROBE_OUT_OF_SCOPE`) or `UNAVAILABLE` fails the exit code;
   - P09 reads `PASS`, or `UNAVAILABLE` with the G9 delegation inspection recorded
     (exactly one entry, `sa-dwd`'s client id, scope exactly `gmail.readonly`,
     `sa-directory` absent).

   - **P10 reads `PASS` through the alert identity (#674)**. The probe still
     records P10 without gating (`scripts/google/lib/probe.ts` `REQUIRED_CHECKS`
     omits it), because its directory token source mints only the group-member
     scope (`probe.ts:268-269`, `credentials.ts:135`). As wired today P10 cannot
     read `PASS`, so **G5 fails and real mail waits for #674**. #674 gives P10 a
     Reports token minted through the alert identity and adds P10 to
     `REQUIRED_CHECKS`; from then on G5's evidence is P10 `PASS` on the probe's
     P10 line and a probe exit code of 0.

   Expected and not gating: P04 `FAIL` and P05, P06 `SKIPPED` (the client holds
   only `gmail.readonly`; P05 has no designated message either: record "P05 not
   run in production" in the G5 evidence), P11 `MANUAL`, P12 `UNAVAILABLE`. A P14 `FAIL` names the guard's reason
   (`owner_mismatch`, `not_in_provider_group`, `no_consent`, …): fix that at step 9
   and rerun. A P13 `UNAVAILABLE` "inconclusive" means the out-of-scope account
   was refused for another reason than not being allowlisted: fix the
   configuration and rerun; G5 needs `PASS`.
5. Record the observed STS ARN (G6): the `google.subject` of the token exchange in
   the GCP project's STS audit log for the probe's time. Under option (b), the
   CCO confirms the expected out-of-list token alert from P13's mint.
6. Move the DNS Firewall from `ALERT` to `BLOCK`. Every `ALERT` hit has already
   fired the `conductia-discovery-dns-firewall-hits` alarm, inside the announced
   window. As admin, list the names this run looked up outside the allowlist
   (names only; the query log holds no content):

   ```bash
   export AWS_PROFILE=<admin profile>
   aws logs filter-log-events --log-group-name /conductia/discovery-worker/resolver-queries \
     --filter-pattern '{ $.firewall_rule_action = "ALERT" }' --start-time <probe start, epoch ms> \
     --query 'events[].message' --output json | jq -r '.[] | fromjson | .query_name' | sort | uniq -c
   ```

   Each name must be a platform name (AWS, Google or Supabase) the worker or
   Fargate needs. Add each to `dns_allowlist`. A name that is not a platform name
   is a finding: stop, and escalate to the owner and the CCO. Then, in the
   tfvars file:

   ```hcl
   dns_allowlist       = ["<missing platform name>"]
   dns_firewall_action = "BLOCK"
   ```

   Announce the window to the CCO, apply (`plan -out`, then `apply` of that plan,
   as in step 6), and rerun the probe once (items 1, 3 and 4). It must stay green.
   From now on a lookup outside the allowlist is answered NXDOMAIN and alarmed.

Verify: the green criteria above hold for the run and for the rerun after the
DNS move;
`aws route53resolver list-firewall-rules --firewall-rule-group-id <dns_firewall_rule_group_id> --query 'FirewallRules[].[Name,Action,BlockResponse]' --output text`
prints `everything-else BLOCK NXDOMAIN`; and the log lines are saved in the
deployment record as G5 evidence.

## 11. The exclusion check from the task (G2)

`classify-once` reads every allowed mailbox of the tenant, so this step is
guarded by a stop rule. Each Gmail mailbox is read from its window (#353): a new
source's first read takes mail from 90 days before it was registered, and
nothing older. This run is the persona source's first read, so its window is
fixed from here on; the two test mails below are recent and fall inside it.

1. **Stop rule.** In the SQL editor:

   ```sql
   select count(*) as allowed_rows,
          count(*) filter (where user_id = '<persona user id>') as persona_rows
     from allowed_mailboxes where tenant_id = '<tenant id>';
   ```

   Both must be 1. If the tenant has any allowed mailbox but the persona, stop.
2. The Ignatious exclusion policy exists (after #338):
   `select count(*) from discovery_exclusion_policies where tenant_id = '<tenant id>'`
   is at least 1. If not, stop.
3. **(human step)** Empty the persona's mailbox of everything (Google's welcome
   mails included), then, signed in as the out-of-scope test account, send two
   mails to the persona: one the Ignatious exclusion policy excludes, and one it
   admits. The admitted one names the test deal's code name, so the firm's
   routing rules route it and it is stored; a mail that routes nowhere is read
   and ledgered but never stored. `gmail.readonly` cannot insert mail, so a human
   sends both.
4. `deal_discovery` is on since step 9, and `discovery_worker_enabled` stays off:
   `classify-once` checks only `deal_discovery`.
5. As `deploy`, run the `once` family (`classify-once --tenant <tenant id>`), then
   read its log as admin:

   ```bash
   export AWS_PROFILE=<deploy profile>
   aws ecs run-task --cluster conductia-discovery --task-definition conductia-discovery-once \
     --launch-type FARGATE --count 1 \
     --network-configuration 'awsvpcConfiguration={subnets=[<private subnet a>,<private subnet b>],securityGroups=[<security group id>],assignPublicIp=DISABLED}' \
     --query 'tasks[0].taskArn' --output text
   aws ecs wait tasks-stopped --cluster conductia-discovery --tasks <task arn>
   aws ecs describe-tasks --cluster conductia-discovery --tasks <task arn> \
     --query 'tasks[0].[stoppedReason,containers[0].exitCode]'
   aws logs get-log-events --log-group-name /conductia/discovery-worker --profile <admin profile> \
     --log-stream-name once/worker/<task id> --query 'events[].message' --output text
   ```

6. Read the evidence. The run's summary line for the tenant
   (`Tenant <tenant id>: read … stored 1, fetched 1, excluded 1, …`) must show
   **`stored 1`** (the admitted mail), **`fetched 1`** (content came back for the
   admitted mail only, never for the excluded one; a request that failed or found
   nothing counts 0) and **`excluded 1`**. And in
   the SQL editor, one stored item for the persona's source:

   ```sql
   select count(*) from source_item_sources where content_source_id = '<persona source id>';
   ```

If any of these cannot be produced, G2 fails. Escalate to the owner and the CCO;
there is no partial pass.

Verify: the exit code is 0, the summary line reads `stored 1, fetched 1, excluded 1`,
the SQL count is 1, and the line and the count are in the deployment record as
G2 evidence.

## 12. Gates G1 to G9

G0 was signed at step 7, G6 at step 8, G5 and G7 at step 10, and G2 at step 11.
This step ticks the rest, each with its evidence in the deployment record (the
[gate table](#go-live-gates) says what each needs).

1. **G1.** The recorded build commit contains #331's merge commit:
   `git merge-base --is-ancestor <#331 merge commit> <build sha> && echo "#331 in"`,
   and the build record from step 5 shows the clean worktree, the 40-hex label and
   the `<sha>-<n>` tag.
2. **G3, before the start.** Step 11's stop rule still holds (one allowed row,
   the persona), and the out-of-list token alert's allowlist names only the persona.
3. **G4 (human step, owner).** The owner records in writing that the hosted
   project holds no other bank's real mailbox content, today or before #264.
4. **G8**, item by item. As admin unless said otherwise:
   1. ECS Exec is off on both services:

      ```bash
      export AWS_PROFILE=<admin profile>
      aws ecs describe-services --cluster conductia-discovery \
        --services conductia-discovery-classify conductia-discovery-extract --query 'services[].enableExecuteCommand'
      ```

      It prints `false` twice.
   2. `deploy` was the owner's own principal, for the push and the probe runs:

      ```bash
      aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=<deploy_role_arn> \
        --query "Events[?EventName=='AssumeRole'].[EventTime,EventId]" --output text
      ```

      Open each event id in CloudTrail › Event history and confirm the caller is
      the owner's own user (`iam_user`, with the MFA device in the request) or
      the owner's Identity Center session (`sso`). Under `sso`, record the
      permission set's MFA setting (IAM Identity Center › Settings ›
      Authentication › Multi-factor authentication: every sign-in) and its
      session duration (1 hour at most).
   3. The push at step 5 succeeded as `deploy`, under the deny:

      ```bash
      aws iam get-role-policy --role-name conductia-discovery-worker-deploy --policy-name discovery-worker-deploy \
        --query "PolicyDocument.Statement[?Effect=='Deny'].Action"
      ```

      The list includes `kms:*` and `secretsmanager:*`. Every log read in steps
      10 to 12 was made as admin (the deny covers the worker key the log groups
      are under).
   4. The DNS Firewall's action is `BLOCK` (step 10's Verify line).
   5. **Delivery to both the owner and the CCO.** Each recipient records, per
      item, that the mail arrived and when:
      - the real events from steps 2 to 11: `deploy-role-assumed`,
        `ecs-operation` (`RegisterTaskDefinition` at step 6, `RunTask` at steps
        10 and 11) and `secret-changed` (steps 3, 4 and 8);
      - a deliberate EventBridge rule change, inside an announced window. Step
        2's `PutRule` events fired before the subscriptions were confirmed, so
        they prove nothing. As admin, create a disabled rule that matches
        nothing, then delete it:

        ```bash
        export AWS_PROFILE=<admin profile>
        aws events put-rule --name conductia-g8-synthetic --state DISABLED \
          --event-pattern '{"source":["conductia.g8.synthetic"]}' --query RuleArn --output text
        aws events delete-rule --name conductia-g8-synthetic
        ```

        Both recipients receive two `tamper-eventbridge` alerts (`PutRule`,
        `DeleteRule`);
      - a sample GuardDuty finding:

        ```bash
        aws guardduty create-sample-findings --detector-id <guardduty_detector_id> \
          --finding-types 'Execution:Runtime/ReverseShell'
        ```

      - a synthetic DNS Firewall hit. Check the alarm's pattern against a
        synthetic record first, then write the record into the query-log group.
        The record names a test domain and nothing else:

        ```bash
        jq -cn '[{version: "1.100000", query_name: "g8-synthetic-test.invalid.", firewall_rule_action: "BLOCK"} | tojson]' \
          > /tmp/g8-messages.json
        aws logs test-metric-filter \
          --filter-pattern '{ ($.firewall_rule_action = "ALERT") || ($.firewall_rule_action = "BLOCK") }' \
          --log-event-messages file:///tmp/g8-messages.json --query 'length(matches)'
        jq -cn --argjson ts "$(date +%s)000" \
          '[{timestamp: $ts, message: ({version: "1.100000", query_name: "g8-synthetic-test.invalid.", firewall_rule_action: "BLOCK"} | tojson)}]' \
          > /tmp/g8-events.json
        aws logs create-log-stream --log-group-name /conductia/discovery-worker/resolver-queries --log-stream-name g8-synthetic
        aws logs put-log-events --log-group-name /conductia/discovery-worker/resolver-queries \
          --log-stream-name g8-synthetic --log-events file:///tmp/g8-events.json
        rm /tmp/g8-messages.json /tmp/g8-events.json
        ```

        `test-metric-filter` prints 1. Within 5 minutes the
        `conductia-discovery-dns-firewall-hits` alarm reaches both;
      - the overrides rule, through the one owner-approved exception run. IAM
        has no condition key for container overrides, so this alert is the
        control, and it is tested once. Record the owner's approval first, then,
        as `deploy`:

        ```bash
        export AWS_PROFILE=<deploy profile>
        task=$(aws ecs run-task --cluster conductia-discovery --task-definition conductia-discovery-probe \
          --launch-type FARGATE --count 1 \
          --network-configuration 'awsvpcConfiguration={subnets=[<private subnet a>,<private subnet b>],securityGroups=[<security group id>],assignPublicIp=DISABLED}' \
          --overrides '{"containerOverrides":[{"name":"worker","command":["probe"]}]}' \
          --query 'tasks[0].taskArn' --output text)
        ```

        Both recipients receive the `ecs-task-overrides` alert: it fires on the
        `RunTask` call, whatever the task then does. The command `probe` without
        `--live` refuses at argument parsing, before any database or Google
        call, so the run reaches nothing even if it starts.

        Kill-switch lever 2's stop is tested on this run, deterministically: the
        task must still be listed when it is stopped, and must end stopped by
        `deploy`, not by exiting on its own. Immediately, as `deploy` (Fargate
        takes tens of seconds to provision, so the task is still listed):

        ```bash
        aws ecs list-tasks --cluster conductia-discovery --desired-status RUNNING --query 'taskArns[]' --output text \
          | tr '\t' '\n' | grep -Fx "$task" || echo "STOP: the task is not listed; the stop test failed"
        aws ecs stop-task --cluster conductia-discovery --task "$task" --reason g8-stop-test --query 'task.taskArn' --output text
        aws ecs wait tasks-stopped --cluster conductia-discovery --tasks "$task"
        aws ecs describe-tasks --cluster conductia-discovery --tasks "$task" \
          --query 'tasks[0].[lastStatus,stoppedReason,stopCode,stoppedAt]' --output text
        aws ecs list-tasks --cluster conductia-discovery --desired-status RUNNING --query 'length(taskArns)'
        ```

        The test passes only when the first command prints the task ARN (not
        `STOP`), `describe-tasks` reads `STOPPED`, `g8-stop-test` and
        `UserInitiated`, and the last command prints `0`. If the task was no
        longer listed, or stopped for another reason (`EssentialContainerExited`:
        it exited before the stop), the test failed: record it, and repeat the
        override run once more under a new owner approval. Then, as admin,
        record the `StopTask` event id, and both recipients record the
        `ecs-operation` alert for it:

        ```bash
        aws cloudtrail lookup-events --profile <admin profile> \
          --lookup-attributes AttributeKey=EventName,AttributeValue=StopTask --max-results 5 \
          --query 'Events[].[EventTime,EventId,Username]' --output text
        ```

        The event at the stop's time, made by the `deploy` session, is the one;
        its id goes into the deployment record beside the task ARN;
      - the out-of-list token alert: under G0 option (a), its owner (to be set
        in #674) fires the deliberate test event; under option (b), the alert
        from P13's mint at step 10, which the CCO confirmed then.
5. **G9 (human step, Ignatious admin).** The #342 GCP-side gates (locked sink,
   alerts, CCO viewer, holders attested, legacy delegation rows cleared), and the
   delegation inspection: Admin console › Security › Access and data control ›
   API controls › Manage Domain Wide Delegation holds exactly one entry,
   `sa-dwd`'s client id, with exactly
   `https://www.googleapis.com/auth/gmail.readonly`, and no entry for
   `sa-directory`'s client id.

If any gate cannot be evidenced, stop: step 13 does not start.

Verify: the deployment record holds G0 to G9, each signed by its signers with its
evidence, date and time.

## 13. Start, in three moves

This is the only step that turns `discovery_worker_enabled` on, sets
`start_approved = true` or sets a desired count above zero. The worker first runs
on the test persona alone, G10 is rehearsed on it, and only then are real users
allowlisted: no real user's mail is read until every gate, G10 included, is
ticked. Announce each move's window to the CCO.

### 13.1 Start on the test persona

1. Precondition: G0 to G9 are signed, and step 11's stop rule holds again, in the
   SQL editor:

   ```sql
   select count(*) as allowed_rows,
          count(*) filter (where user_id = '<persona user id>') as persona_rows
     from allowed_mailboxes where tenant_id = '<tenant id>';
   ```

   Both must be 1. Otherwise stop.
   - **The window (#353).** Open `/discovery` as the firm admin. Each Gmail
     source shows a Window line: "Reads mail from <date>", or "Whole mailbox"
     for a source that read before windows existed. A source's first read takes
     mail from that date and nothing older; the incremental sync then reads new
     mail as before. The default is 90 days before the source was registered.
     The persona's first read ran at step 11, so its line shows the date it
     read from (or "Whole mailbox", if step 11 ran before the window shipped)
     and it has no Change window control: that is expected. Record each
     source's Window line in the deployment record.
   - A source that still shows **Change window** has not read yet. If the owner
     asked for another window for it, set it now: Change window, a date from
     today back to 730 days before today (UTC), Save. Each change is audited
     (`discovery.mailbox_access_changed`, `change` `window_set`, with `from` and
     `to`), and the CCO sees the window without the control. The worker locks
     the window when it starts the first read, before its first Gmail request,
     reading the date in the same step. A Save that loses that race answers
     "Reading has started. The window is fixed for this pass." and changes
     nothing: the source reads the date its Window line shows, so refresh and
     record that one. After that the control is gone for the read; moving the
     window earlier afterwards is not built (#353 follow-up F2).
   - **Long windows** (Proposed, until a read rate is measured: #353 follow-up
     F5). A window earlier than the default makes that mailbox's first read
     longer. One worker reads mailboxes in turn, so first reads that run at the
     same time add up: each one's elapsed time comes close to the sum of all of
     them. A first read that takes more than 5 days can halt (step 14, "A
     halted first read").
     1. Project the read before choosing the date, because the window cannot
        be shortened once the read starts. Days to read are about the
        mailbox's mail per day, times the window's days, divided by the rate.
        The rate is a reader pass's fetched count over the time between its
        start and end (the source's "Last reader pass" line on `/discovery`),
        from a mailbox of this tenant that has read. Before any has, the
        design's unmeasured estimate is about 180,000 messages a day for one
        mailbox reading alone: two years of 500 mails a day is about 2 days,
        of 1,000 a day about 4. If the projection is over 4 days, choose a
        later date.
     2. Start it with the other first reads paused: keep every source that
        still shows Change window paused until the long read completes (its
        Last sync line shows a time instead of Never), then resume them.
        Never pause a source in the middle of its first read: its 5-day clock
        keeps running while it is paused.
     3. After its first hour, read its rate from its own reader passes the
        same way, and record it with the projection. If the projection is now
        over 4 days, tell the owner: the read runs on, and if it halts, step
        14's recovery shortens it.
2. The worker flag on:

   ```sql
   update feature_flags set enabled = true where key = 'discovery_worker_enabled';
   ```

3. In the tfvars file, the start's two variables, together:

   ```hcl
   start_approved         = true
   classify_desired_count = 1
   ```

4. Apply as admin. The same apply creates the tick and running-task alarms,
   which exist only while the worker is meant to run:

   ```bash
   export AWS_PROFILE=<admin profile>
   tofu -chdir=infra/discovery-worker plan -var-file=ignatious.tfvars -out=start.tfplan
   tofu -chdir=infra/discovery-worker apply start.tfplan
   rm infra/discovery-worker/start.tfplan
   aws ecs wait services-stable --cluster conductia-discovery --services conductia-discovery-classify
   aws logs filter-log-events --log-group-name /conductia/discovery-worker \
     --filter-pattern '{ ($.evt = "tick") || ($.evt = "sync") }' --start-time <apply time, epoch ms> \
     --query 'events[].message' --output text
   ```

   Within 10 minutes the log shows `{"evt":"tick","queued":1}` and a `sync` line
   for the persona's source id.

Verify: `aws ecs describe-services --cluster conductia-discovery --services conductia-discovery-classify --query 'services[].[desiredCount,runningCount]'`
prints 1 and 1; the tick and sync lines above appear; and
`aws cloudwatch describe-alarms --alarm-names conductia-discovery-no-tick conductia-discovery-no-running-task --query 'MetricAlarms[].StateValue'`
prints `OK` twice once the first 15 minutes have passed.

### 13.2 G10: rehearse the kill switch on the test persona

With the worker running on the persona alone, pull each lever of step 14 once
and time it, in the order 1, 3, 4, 2, 5, so that each lever's effect is still
visible when it is pulled. Record every time in UTC. Announce the rehearsal
window to the CCO: the tick alarm, the tamper rules (the alarms are deleted when
the count returns to 0) and `secret-changed` all fire during it, as expected.

1. **Lever 1, the flag (T1).** `update feature_flags set enabled = false where key = 'discovery_worker_enabled';`.
   Measure T1 to the last `sync` line, as admin:

   ```bash
   aws logs filter-log-events --profile <admin profile> --log-group-name /conductia/discovery-worker \
     --filter-pattern '{ $.evt = "sync" }' --start-time <T1, epoch ms> --query 'events[].[timestamp,message]' --output text
   ```

   Ticks go on printing `{"evt":"tick","queued":0}`.
2. **Lever 3, the key (T3).** Delete the `discovery-worker-aws` key in the
   dashboard (Project Settings › API Keys). The next tick reads the flags over
   REST and fails: the log shows `{"evt":"tick","status":"failed",…}` within
   5 minutes. Record T3 and that line's time.
3. **Lever 4, the queue login (T4).** Generate a new password into
   `~/conductia-secrets/queue-password` as in step 4, then, in the SQL editor as
   `postgres`:

   ```sql
   alter role discovery_queue with password '<the new password>';
   select pg_terminate_backend(pid) from pg_stat_activity where usename = 'discovery_queue';
   select count(*) as queue_sessions from pg_stat_activity where usename = 'discovery_queue';
   ```

   `queue_sessions` is 0, and stays 0 a minute later: the worker's reconnects are
   refused, and its log shows `queue_error` lines. Record T4 and the time the
   count reached 0.
4. **Lever 2, the process (T2).** As `deploy`, scale to zero, then stop every
   task still running in the cluster: a standalone probe or `once` run belongs to
   no service, so scaling does not stop it. `list-tasks --desired-status RUNNING`
   drops a task the moment `stop-task` is accepted, while its container may still
   run for up to the 40 s stop timeout, so an empty list proves nothing. The
   loop keeps every ARN it stops, waits until each one's `lastStatus` is
   `STOPPED`, and lists again after each wait to catch a task started meanwhile.
   Then write the same into the tfvars file and apply as admin, so no later apply
   restarts it:

   ```bash
   export AWS_PROFILE=<deploy profile>
   aws ecs update-service --cluster conductia-discovery --service conductia-discovery-classify \
     --desired-count 0 --query 'service.desiredCount'
   stopped=""
   for round in 1 2 3; do
     tasks=$(aws ecs list-tasks --cluster conductia-discovery --desired-status RUNNING \
       --query 'taskArns[]' --output text)
     [ -z "$tasks" ] && break
     for task in $tasks; do
       aws ecs stop-task --cluster conductia-discovery --task "$task" --reason kill-switch \
         --query 'task.taskArn' --output text
     done
     aws ecs wait tasks-stopped --cluster conductia-discovery --tasks $tasks
     stopped="$stopped $tasks"
   done
   [ -n "$stopped" ] && aws ecs describe-tasks --cluster conductia-discovery --tasks $stopped \
     --query 'tasks[].[taskArn,lastStatus,stoppedReason,stoppedAt]' --output text
   aws ecs list-tasks --cluster conductia-discovery --desired-status RUNNING --query 'length(taskArns)'
   aws ecs describe-services --cluster conductia-discovery --services conductia-discovery-classify \
     --query 'services[0].[desiredCount,runningCount,pendingCount]' --output text
   ```

   Lever 2 holds only when all of these read so: every ARN in the
   `describe-tasks` output has `lastStatus` `STOPPED` (with `kill-switch` as its
   `stoppedReason`, or the service's own scale-down reason), the final
   `list-tasks` prints `0`, and the service reads `0 0 0`. If `wait
   tasks-stopped` times out, or a third round still finds tasks, something is
   starting them: treat it as an incident (step 14) and pull lever 5 at once.

   ```hcl
   classify_desired_count = 0
   start_approved         = false
   ```

   Record T2, every stopped task ARN with its `stoppedAt`, and the latest
   `stoppedAt` as the time lever 2 took effect.
5. **Lever 5, Google (T5).** The Ignatious admin runs the kit's T+0: remove the
   principalSet bindings from `sa-dwd` and `sa-directory`, and disable `sa-dwd`.
   Evidence: `gcloud iam service-accounts describe <sa-dwd email> --project=<gcp project> --format='value(disabled)'`
   prints `True`, and the two policies hold no principalSet entry.
6. **The token tail, an upper bound.** From the GCP IAM Credentials data-access
   log, the time of the last successful `signJwt` before T5, plus 3,600 s (the
   reader's assertions set `exp = iat + 3600`; federated and impersonated tokens
   last 1 hour). Fully dark is no later than that.

Then restart the same way:

1. The Ignatious admin restores the bindings and enables `sa-dwd` (the kit's
   production profile again, same mode); rerun step 8's `check-gcp-policy.ts`,
   which must print `PASS` (G6).
2. A new `discovery-worker-aws` key, as in step 3 (prefix check, then
   `put-secret-value` from a file).
3. The queue URL with lever 4's new password, as in step 4 (the `psql` check,
   then `put-secret-value` from a file).
4. The probe again (step 10, items 1, 3 and 4): it must be green (G5).
5. Move 13.1 again: the stop rule, the flag on, `start_approved` and
   `classify_desired_count = 1` in tfvars, apply, and a tick line.

Verify: the deployment record holds T1 to T5, the time each lever took effect
(last `sync` line, failed tick, zero queue sessions, every listed task
`STOPPED` by `describe-tasks` and none left listed, `sa-dwd` disabled), the token-tail bound, the restart's `PASS`, green probe and tick, and
G10 signed.

### 13.3 The consenting users

Only after G10 is signed. For each consenting user:

1. **(human step)** The user is invited through the Team page of the deals they
   work on, accepts and holds a seat.
2. **(human step, Ignatious admin)** The user is added to the allowlist group.
3. **(human step, owner: to be set in #674)** The out-of-list token alert's
   allowlist gains the user's address (G3), before the user connects, so the
   first token for the mailbox is never outside the alert's list.
4. **(human step)** The user signs in as themselves, opens Profile › Deal
   discovery, ticks the agreement and selects **Connect my mailbox**. The opt-in
   creates or adopts their source.
   - The source's first read starts at the next tick, within 5 minutes, from
     the date on its Window line on `/discovery`: 90 days before the source
     was registered, so an adopted source keeps the date it already had. If
     the owner asked for another window for this user, the firm admin pauses the source on `/discovery` as soon as it appears, sets
     the window (Change window, as in 13.1), and resumes it, following 13.1's
     long-window guidance for a date earlier than the default. If Change window is already gone, or Save
     answers "Reading has started", the worker claimed the first read first: it reads the date the Window line
     shows, and the change was neither saved nor audited. Record that date in the deployment record.

Verify, with counts only: `select count(*) from allowed_mailboxes where tenant_id = '<tenant id>' and provider = 'google'`
equals the consenting users plus the persona; step 9's
`sources_owned_by_the_allowed_user` query returns the same number; the
out-of-list token alert's allowlist matches; and G3 is signed in its final form.

## 14. Kill switch, rotation and rollback

**Levers, fastest first.** Each is independent of the others. Levers 2 to 6 are
containment; lever 1 is an operations lever, because it lives in the hosted
database, which the worker's key can write.

| # | Lever | Who | Stops | Bound |
|---|---|---|---|---|
| 1 | `discovery_worker_enabled` off (SQL editor) | owner | the consumer's ticks and new sync pages | 30 s flag cache plus the rest of the current page; under throttling a page can take minutes (up to 6 attempts, sleeps capped at 64 s). It does not stop a `once` run, which checks only `deal_discovery`: turn that off too for a full stop (a global change, G0) |
| 2 | Scale `conductia-discovery-classify` to 0 and stop every running task of the cluster (`list-tasks`, `stop-task` each, `wait tasks-stopped` on those ARNs, then list again: a probe or `once` run belongs to no service) as `deploy`, and in the same step `classify_desired_count = 0` and `start_approved = false` in tfvars, applied as admin | owner | the process, standalone runs included | `SIGTERM`, 30 s graceful stop; no later apply restarts it |
| 3 | Delete the `discovery-worker-aws` key (dashboard › Project Settings › API Keys) | owner | all REST, the guard included | seconds |
| 4 | Rotate the `discovery_queue` password, then terminate its sessions (SQL editor, as `postgres`) | owner | the queue login and its open sessions | seconds |
| 5 | The kit's T+0: remove the principalSet bindings, disable `sa-dwd` | Ignatious admin | new Google tokens | seconds for new mints |
| 6 | Delete the domain-wide delegation entry | Ignatious admin | new delegated tokens, domain-wide | minutes (Google propagation) |

The commands are those of step 13.2: lever 1's `update`, lever 2's
`update-service --desired-count 0`, the stop loop (`list-tasks`, `stop-task`,
`wait tasks-stopped`, list again) and its `describe-tasks` check that every
stopped ARN reads `STOPPED`, the tfvars pair and an apply, lever 3 in
the dashboard, lever 4's `alter role` and `pg_terminate_backend`, lever 5 in the
kit, lever 6 in the Admin console. For an extract service started under P2 = B,
lever 2 also scales `conductia-discovery-extract` and sets
`extract_desired_count = 0`.

**Stopping extraction alone (no deploy).** As `deploy`:
`aws ecs update-service --cluster conductia-discovery --service conductia-discovery-extract --desired-count 0`,
then `list-tasks --service-name conductia-discovery-extract`, `stop-task` each, and
`wait tasks-stopped` on those ARNs. The extract task stops on `SIGTERM`: it finishes the
call in hand, puts it on record and clears its reservation, sends nothing more and exits
0, well inside the 40 s `stopTimeout`. A stop that lands while a ZDR refusal waits to be
asked again (D106) ends the wait: that refusal is the item's last attempt, recorded as
failed, counted at the item's ceiling and settled like one that outlasted the retries, and
the task exits 1 with the ZDR line. Only a call still in flight when `SIGKILL` lands
(a model reply slower than the stop window) can be billed with no `model_calls` row and
no ledger row. Its reservation is then still set (the run takes it before every send and
clears it last), so the next pass counts that item at its ceiling and sends nothing
(`"capped":"unpriced"`) until the owner reads it and renews
the budget ("Switching later", P2 = A to B, "Budget renewal and stops"). Then, applied
as admin, set `extract_desired_count = 0` (and `extract_gateway_enabled = false`, to drop
the key from the task) so the next apply does not scale it back. Rehearse it once with G10.

**In an incident** (an alert outside an announced window, a GuardDuty finding,
the address alarm): pull 2 (the service to zero **and** every running task of
the cluster stopped, probe and `once` runs included), 3 and 5 together, then 4
and 6, then 1. Record the time of each. Then rotate every secret below before any restart, and restart
only through step 13.1 with the gates the incident touched signed again.

**Time to fully dark is the last lever plus up to 1 hour.** Google tokens already
minted stay valid until they expire: the federated STS token, the impersonated
directory token and every delegated `gmail.readonly` token, each up to 1 hour.
Removing a binding or disabling `sa-dwd` stops new mints, not those. AWS
task-role credentials (up to about 6 hours) matter only for minting new Google
tokens, which lever 5 blocks. G10 records the tail as an upper bound: the last
successful mint in the GCP data-access log plus 3,600 s. No lever is defeated by
a legacy key: the task refuses at startup any Supabase key that is not an
`sb_secret_` key, and deleting that key revokes it (deleting a secret key would
not revoke a legacy JWT key).

**Rotation, per secret.** No procedure prints a value. A forced redeploy, as
`deploy`:

```bash
export AWS_PROFILE=<deploy profile>
aws ecs update-service --cluster conductia-discovery --service conductia-discovery-classify \
  --force-new-deployment --query 'service.deployments[0].rolloutState'
```

| Secret | Procedure | Cadence | Verify |
|---|---|---|---|
| `discovery-worker-aws` key (`supabase-worker-secret-key`) | create a new secret key in the dashboard; prefix check and `put-secret-value` from a file (step 3); forced redeploy; one tick; delete the old key | 90 days, and at once on any suspicion | `list-secret-version-ids` shows the new `AWSCURRENT`; a `{"evt":"tick","queued":…}` line after the redeploy; the old key is gone from the dashboard |
| `discovery_queue` password (`discovery-queue-database-url`) | `alter role discovery_queue with password …` in the SQL editor; the new pooler URL through step 4's `psql` check and `put-secret-value`; forced redeploy; terminate the old sessions (lever 4's `pg_terminate_backend`) | 90 days | `psql` printed `discovery_queue`; the new `AWSCURRENT`; a tick after the redeploy |
| Workload identity configs (`google-wif-dwd-config`, `google-wif-directory-config`) | not secret; replaced only when the kit is rerun (mode switch, pool change): key-material check and `put-secret-value` (step 8); `check-gcp-policy.ts` for the mode; forced redeploy; the probe (step 10) | on change | the policy check `PASS`; a green probe |
| Index digest key (`discovery-index-digest-key`) | a new random value into a file and `put-secret-value` (step 3, item 4); forced redeploy | on suspicion only: the next read re-processes and re-keys every indexed message | the new `AWSCURRENT`; a tick after the redeploy |
| `ai-gateway-api-key` (P2 = B only) | a new key at the gateway; `put-secret-value` from a file; forced redeploy of `conductia-discovery-extract`; revoke the old key | 90 days | the new `AWSCURRENT`; the extract service's next run |
| Probe parameters | `aws ssm put-parameter --overwrite --type SecureString --key-id <kms_key_arn>` with `--value file://…` (step 3) when a test account changes; a new out-of-scope account is registered at G0 again | on change | `describe-parameters` (no value read) shows the next version under the worker key |
| The worker and trail keys | automatic yearly rotation | yearly | `aws kms get-key-rotation-status --key-id <kms_key_arn>` prints `true` |

**Apply windows.** Every apply, rotation and rehearsal is announced to the CCO
beforehand, with its start and end. The alert rules fire on all of them; an alert
outside an announced window is an incident.

**Rollback.** A new image that misbehaves: pull lever 2, then set `image_digest`
back to the last digest that passed G1, G2 and G5 (from the deployment record),
apply at zero, and restart through step 13.1. A digest no gate has seen never
runs on real mail (step 5's rebuild rule). Recovery is one apply and a task
start, about 5 minutes. A bad infrastructure change: revert the tfvars or module
change and apply; the state bucket is versioned. Never roll back by deleting the
services: the next apply recreates them at the tfvars count.

**A halted first read (#353).** A first read that took more than 5 days, and
whose Gmail history cursor expired meanwhile, halts: the source shows Halted
(`history_window_exceeded`) and is neither queued nor read. A plain restart reads
the same window again and is likely to halt again, so shorten the window first.
As the firm admin on `/discovery`, in this order:

1. **Pause** the source. A paused source is never queued, so the worker cannot
   start reading, and fix the window, between the next two moves.
2. **Restart reading**, and confirm. The confirm names the date the read would
   start from. The restart clears the halt and the stored cursor, which opens
   the window again.
3. **Change window**: a later date, then Save (13.1's long-window projection
   says how much later).
4. **Resume.** The next tick reads the mailbox again from the new date. Mail
   already stored stays stored and is not stored twice; a shorter window
   deletes nothing.

Restart is refused for 24 hours after the source's previous restart ("Restart is
not available right now."), so this recovery is available once per 24 hours per
source. Each move writes a `discovery.mailbox_access_changed` row (`paused`,
`restarted`, `window_set` with `from` and `to`, `resumed`); record their times in
the deployment record. A source that is still reading cannot be shortened: its
window stays fixed until the read completes or halts.

Verify: after any use of this step, the deployment record holds the time of each
lever pulled, the fully dark time (last lever plus the token tail), and each
rotation's Verify line.

## 15. Teardown

In this order, each announced to the CCO, as admin unless said otherwise:

1. **Stop.** Levers 1 and 2 (tfvars 0 and `start_approved = false`, applied).
   Turn `deal_discovery` off only if no other tenant relies on it (a global
   change, the owner's call).
2. **Google.** The Ignatious admin deletes the delegation entry (lever 6), runs
   the kit's T+0 (lever 5), then removes `sa-dwd`, `sa-directory` and the pool as
   the kit's README says.
3. **Supabase.** Delete the `discovery-worker-aws` key (lever 3); rotate the
   `discovery_queue` password and terminate its sessions (lever 4).
4. **Keep the evidence.** The trail bucket and its key stay for the audit period,
   outside the destroy. When the detector predates this module
   (`guardduty_detector_id` set), its runtime-monitoring setting stays too:

   ```bash
   tofu -chdir=infra/discovery-worker state rm aws_s3_bucket.trail aws_s3_bucket_versioning.trail \
     aws_s3_bucket_server_side_encryption_configuration.trail aws_s3_bucket_public_access_block.trail \
     aws_s3_bucket_ownership_controls.trail aws_s3_bucket_policy.trail aws_kms_key.trail aws_kms_alias.trail
   tofu -chdir=infra/discovery-worker state rm 'aws_s3_bucket_object_lock_configuration.trail[0]'   # only with Object Lock
   tofu -chdir=infra/discovery-worker state rm aws_guardduty_detector_feature.runtime_monitoring    # only with an existing detector
   ```

5. **Empty the image repository**, which refuses deletion while it holds images:

   ```bash
   aws ecr batch-delete-image --repository-name conductia-discovery-worker \
     --image-ids "$(aws ecr list-images --repository-name conductia-discovery-worker --query 'imageIds' --output json)"
   ```

6. **The probe parameters**, which the module does not manage:

   ```bash
   aws ssm delete-parameters --names /conductia/discovery-worker/probe/mailbox /conductia/discovery-worker/probe/out-of-scope \
     --query 'DeletedParameters' --output text
   ```

7. **Destroy.** `tofu -chdir=infra/discovery-worker destroy -var-file=ignatious.tfvars`.
   The alert rules fire until they are deleted, inside the window. The secrets
   enter Secrets Manager's recovery window and the worker key its 30-day deletion
   window.
8. The state bucket (`prevent_destroy`) and the bootstrap state stay with the
   deployment record until the audit period ends; then the owner empties and
   deletes them by hand.

Verify: `aws ecs list-clusters` does not list `conductia-discovery`;
`aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/conductia/discovery-worker/ --query 'length(Parameters)'`
prints `0`;
`aws cloudtrail describe-trails --query 'trailList[].Name'` does not list
`conductia-discovery-worker`; the Ignatious admin confirms the delegation entry
and the two service accounts are gone; the dashboard no longer lists the
`discovery-worker-aws` key; and `aws s3 ls s3://<trail_bucket>/` still lists the
`AWSLogs/` prefix.

At pilot end, the tenant purge in [Deleting stored mail](#deleting-stored-mail)
runs after item 1 and before item 3. It needs only the hosted database, not the
worker. Once the worker is gone, nothing runs the backstop, so mail kept under a
legal hold is deleted by hand after the hold is lifted (same section). Project
deletion follows the tenant purge, never precedes it
([Decommissioning a tenant](#decommissioning-a-tenant)).

## Deleting stored mail

Proposed (#461). The owner decided on 2026-10-13 that G0 commits Conductia to
deleting stored mail when a banker disconnects and at pilot end. On 2026-10-14
the owner split what is stored into content, which is deleted, and a message
index that holds no content (the Message-ID only as its SHA-256, owner
2026-10-17; its content digest is keyed per tenant, owner 2026-10-17), and made retention a
policy per tenant. On 2026-10-17 the owner sequenced the work: the consent-end
purge, the backstop and the breaker (#518, #519) merge before real mail; the
tenant purge, the index, its export and the retention policy (#520, #528 to
#530) after Oct 30. On 2026-10-18 the owner moved those ahead of Oct 30 so the
index covers real mail from the start; the whole stack merged in #518. The mechanisms below are built and tested (migrations
`20261014120500_discovery_purge.sql`,
`20261014130000_discovery_purge_wiring.sql`,
`20261014140000_discovery_purge_tenant.sql`,
`20261014150000_discovery_message_index.sql`,
`20261014151000_discovery_message_index_export.sql` and
`20261014160000_tenant_retention_policy.sql`, the worker tick, and
`scripts/discovery/purge-tenant.ts`). Three items stay with the owner, each
marked where it appears: the deletion window, the backup number, and the G0
wording.

**What is stored.** Discovery keeps one copy of each message per tenant
(`source_items` of kind `message`, with its text in `source_item_texts`), shared
by every mailbox that saw it. A mailbox owns only its sightings: its
`content_sources` row, its provenance (`source_item_sources`), its ledger
(`routing_ledger`), its thread taints and its rows in the message index
(`discovery_message_index`). Evidence links, milestone events and model calls
hang off the message. Visibility, stage assessments, recompute requests and
corrections hang off the candidate. Deletion therefore runs in two steps:
**detach** the mailbox, then **collect** every message no mailbox holds any more
and every candidate left with no evidence. One function,
`discovery_purge_identifiers`, does every detach: it deletes the mailbox's
source row (its provenance, ledger and taints cascade) and, when the
[retention policy](#retention-policy) says so, its index rows.

**Content and the index** (owner, 2026-10-14). Content is what a message says
and who it is between: the subject, body text and excerpts, participant names
and addresses, and the names the clusterer or a model proposed for a candidate.
Content is deleted when a banker's consent ends. The index is not content. The
worker writes it when it stores a page, not at deletion: one row per message per
mailbox (a message two bankers hold has two rows), keyed by tenant, mailbox source
and `message_key`, so a banker's purge removes exactly that banker's rows. A
message copied within one mailbox (Outlook gives the copy a new provider id) is
still one row. Each row holds:

| Column | What it is |
|---|---|
| `tenant_id`, `content_source_id`, `provider_item_ids` | the tenant, the mailbox source, and every provider id the message was read under in that mailbox |
| `message_key` | the SHA-256 of the trimmed Message-ID; the raw id is never stored (owner, 2026-10-17, superseding 2026-10-14). The bank matches its archive by hashing its own Message-IDs the same way |
| `sent_at`, `content_digest` | the sent date, and an HMAC-SHA256 of the stored item's content hash under the tenant's key (`hmac-sha256:<64 hex>`; owner, 2026-10-17): without the key it cannot confirm a guessed message, and it says nothing across tenants |
| `candidate_id`, `deal_id` | the candidate the message evidences and the deal it was promoted to, refreshed after each discover run and before any purge; the deal link outlives the candidate |
| `tags` | categories of the incoming-mail screen (`mnpi`, `promissory`; `lexicon-<n>` is reserved), never the matched term |
| `rules_version`, `model`, `prompt_version`, `processed_at` | the rules that processed the message (`DISCOVERY_RULES_VERSION` in `src/lib/discovery/rulesVersion.ts`), a model and prompt version (empty on the rules path), and when |

No subject, body, participant, address or matched term. The index has two
purposes. First, a per-deal export for a regulator: each row names the deal its
message evidenced, so the messages of one deal can be listed and retrieved from
the bank's own archive by the Message-ID's hash (the export itself is not built yet).
Second, the skip rule below. The index covers every message the worker read and
screened on a page, routed to a deal or not. A message the bank's exclusion
policy keeps out is never read, so it is never indexed; neither is a SharePoint
document. Audit rows still carry no Message-ID.

**The skip rule.** Before routing a page, the worker drops each message this
mailbox has already indexed, linked to a candidate or deal, under a known
provider id, with the same content digest and the same rules version. It runs
only on a delta pass of a source whose backfill is complete: never on a
backfill (the first one, the re-backfill after an expired cursor, or a halted
source's restart). A message
that never routed is always routed again, so it can route once its codename
becomes known. A full re-read (`SyncOptions.reread`, #460's `--recount` and
`--propose`) never skips. The skip is counted as `unchanged` on the sync result
and the job line, never logged with ids, and outside `itemsRead`, so #460's
routing split still adds up to `itemsRead`. Bump
`DISCOVERY_RULES_VERSION` when a routing or screening rule changes: the next
read then processes every message again. Known limitation (Proposed follow-up,
for when production first keeps the index): a reconnected mailbox gets a new
source id, so an index row kept from its earlier source does not stop that
mailbox being read and processed again.

**What is out of scope.** SharePoint site content is not mail and is outside G0.
Site sources, their documents, provenance and ledger, and any candidate a
document still evidences survive every operation below. Such a candidate loses
its mail evidence and every stage assessment that cites a deleted milestone, and
is rebased on what remains: its parties, seen dates and confidence come from the
remaining evidence, and a name no remaining item supports becomes "Unnamed
candidate" unless the MD typed it.

### Retention policy

Owner decision (owner, 2026-10-14): retention is a policy per tenant, not pilot
behaviour fixed in code, and moving a tenant to production is a reviewed policy
change with no migration and no UI. The policy is one row per tenant in
`tenant_retention_policies`. RLS is on; of the API roles only `service_role`
reads it, and no role writes the table directly: every write goes through
`tenant_retention_policy_set()`, which requires an operator identity and a
reason. Run it in the SQL editor:

| Column | Values (pilot value first) | What it does |
|---|---|---|
| `lifecycle` | `pilot`, `production`, `decommissioning` | Drives no code. It is shown in the tenant purge report, and set to `decommissioning` before a tenant purge |
| `content_on_disconnect` | `delete`, `keep` | `delete`: a consent's end runs the purge below. `keep`: nothing is deleted. The source is archived (renamed `<address>~xyz`, paused, stamped `archived_at`), so the readers and the index writer refuse it and a later opt-in gets a fresh source; its content and index stay with it. The banker's candidate visibility rows stay with the retained mail, but the banker no longer sees those candidates: access needs an allowed mailbox, and the archived source is none. One `discovery.mailbox_retained` audit row records it (ids, reason and policy values), no `discovery.mailbox_purged` row is written, and the route returns `purged: null`. The address's group-absence rows go either way |
| `index_on_disconnect` | `delete`, `keep` | Applies when content is deleted. `delete`: the mailbox's index rows go with its source, except rows whose deal is under legal hold, which the backstop deletes once the hold lifts. `keep`: they stay, their candidate and deal links refreshed as the mailbox goes |
| `index_at_tenant_end` | `export_then_delete`, `keep` | The tenant purge always writes the index into its report. `export_then_delete`: it then deletes the index. `keep`: the index stays, and the report counts its rows as kept |

The table also holds `updated_by` (the operator the write names, required, never a
secret) and `updated_at`. **A tenant with no row has the pilot values**, which
are the G0 commitment: `tenant_retention_policy('<tenant id>')` returns the
effective policy, so every reader agrees on that default. The database refuses
any other value (a CHECK per column).

**Reviewing and writing a change.** Proposed: the change is one SQL statement,
reviewed by a second person before it runs and recorded in the deployment
record with the request it answers. Read the current policy first, in the SQL
editor:

```sql
select * from tenant_retention_policy('<tenant id>');
```

Then write the change. A choice you leave out keeps the tenant's current
effective value (the pilot value for a tenant with no row), so name only what
changes. The operator and the reason are required, and the function refuses
without them:

```sql
select * from tenant_retention_policy_set(
  '<tenant id>', '<operator>', '<reason and the request it answers>',
  p_lifecycle => 'decommissioning');
```

Every write goes through that function and writes one
`discovery.retention_policy_set` audit row, whose service identity is the
operator, with the operator, the reason, the old values (`null` on a first
write) and the new ones, no content. A refused value writes neither the row nor
the audit row. Verify:

```sql
select ts, detail from audit_log
where tenant_id = '<tenant id>' and action = 'discovery.retention_policy_set'
order by ts desc limit 1;
```

**Known limitations.** A purge reads the policy at the moment a consent ends.
Switching `content_on_disconnect` from `keep` to `delete` does not purge the
mailboxes whose consent already ended under `keep`: their sources and content
stay until the tenant purge. Switching `index_on_disconnect` from `keep` to
`delete` does reach back: the backstop deletes, on its next tick, every index
row whose mailbox source is gone and whose deal is not under legal hold.

### When a banker's consent ends

Four events end a consent. Under the pilot policy, each one purges in the same
transaction:

| Event | Reason in the audit rows | Where it starts |
|---|---|---|
| The banker selects **Stop reading my mailbox** on Profile | `withdrawn` | `DELETE /api/v1/discovery/mailbox-consent`, which calls `mailbox_consent_withdraw()` |
| The banker loses the seat | `seat_lost` | the seat-loss trigger on `users` (for example, a member removed from the firm) |
| The banker's invite is deleted | `invite_deleted` | the invite-delete trigger |
| The banker is out of the ingest group past the grace, and the operator confirms | `group_removed` | the worker tick holds it; the operator releases it ([group removal](#group-removal)) |

Each sets `mailbox_consents.withdrawn_at`, and the `mailbox_consents_purge`
trigger on that update runs `discovery_purge_mailbox`:

1. It detaches the banker's own mailbox source (same address, owned by the
   banker) through `discovery_purge_identifiers`. Provenance, ledger and thread
   taints cascade. Under the pilot policy the mailbox's index rows go too,
   except those linked to a deal under legal hold. An archived
   source of an earlier holder of the address is not touched.
2. It collects. The index's candidate and deal links are refreshed first. Each
   message no mailbox holds any more is deleted, with its text, evidence links,
   milestone events and model calls. A surviving candidate loses each stage
   assessment that cites a deleted milestone. Each candidate left with no
   evidence is deleted, with its visibility, assessments, recompute requests and
   corrections. Survivors are rebased.
3. It refreshes the visibility of the candidates the mailbox backed and writes
   one `discovery.mailbox_purged` audit row: `sourceId`, `consentId`, `reason`,
   `runId` and the counts `provenance`, `ledger`, `taints`, `indexRows`,
   `items`, `texts`, `evidence`, `milestones`, `modelCalls`, `candidates`,
   `corrections` and `heldSkipped`. No address, no Message-ID, no content.

A message a colleague's connected mailbox also holds keeps that colleague's
provenance, so it survives with everything derived from it, and a candidate
survives while any evidence remains. A promoted deal keeps its deal row and
everything the MD typed. Once its candidate has no evidence left, it loses that
mail-derived candidate, the candidate's assessments and its `promote`
correction. The `discovery.candidate_promoted`
audit row stays (ids only).

Nothing is purged, and no `discovery.mailbox_purged` row is written, when the
banker has no mailbox source or still holds another open consent for the same
address. In a tenant whose policy keeps content on disconnect nothing is
deleted either: the source is archived and one `discovery.mailbox_retained` row
is written. The withdrawal itself is always audited
(`discovery.mailbox_consent_withdrawn`).

The purge is synchronous: it measured 365 to 623 ms on a local stack at pilot
scale (one source with 50,000 ledger rows, 51,000 index rows and 2,000 stored
messages, half of them shared with a second mailbox), well inside the statement
timeout of the banker's session (8 seconds, Supabase's default for
`authenticated`). The route returns the counts as `purged`
(`docs/03-engineering/api-v1.md`).

**A withdrawal that exceeds the timeout.** The withdrawal and the purge are one
statement in one transaction (`mailbox_consent_withdraw`). When it runs past the
8 seconds, the database cancels it and rolls back both: `withdrawn_at` stays
null, so the consent stays open, nothing is purged, and no
`discovery.mailbox_consent_withdrawn` or `discovery.mailbox_purged` row is
written. The route answers 500 `Could not withdraw mailbox consent` and the
banker sees an error. The banker's mailbox is still connected, still read and
still stored. Treat the banker as not yet disconnected, and do not tell the
banker or the bank that the mail is deleted. If reading must stop before the
retry, the owner pulls lever 1 (step 14), which is not per banker: it stops the
consumer's ticks and new sync pages. Find why the statement ran long, then retry
the withdrawal: the banker selects **Stop reading my mailbox** again, or the
operator withdraws the consent in the SQL editor with the statement under
[Group removal](#group-removal), using the reason `withdrawn`. The retry has
worked when the consent shows `withdrawn_at` and the audit log holds a
`discovery.mailbox_purged` row for the banker (a `discovery.mailbox_retained`
row, under a policy that keeps content).

The same holds for every way a consent ends, because each runs the same
`withdrawn_at` update: a seat removal or an invite deletion that times out
rolls back too, so the member stays seated or the invite stays, and the admin
retries. Time spent waiting for the tenant's discovery lock (held while the
worker stores a page or the backstop runs) counts toward the 8 seconds.
`supabase/tests/discovery_purge.sql` (test 0) pins the rollback.

**A page in flight.** When the worker is reading the mailbox as the consent
ends, the page's provenance and index writes are refused `source_archived` (its
source is gone) and the worker skips the source. The page's new messages are
left with no provenance, and the [backstop](#the-backstop) deletes them within
one tick plus 15 minutes.

**Reconnecting.** A banker who connects again after a withdrawal gets a fresh
source with an empty checkpoint and no index rows, so the next pass reads and
processes the mailbox from the start, as a first connection does.

### Group removal

Proposed: 72 hours of absence, after the address was seen in the group. Each
successful group check (status `in_sync` or `drift`) records in
`mailbox_group_absence` when a consented address was first seen in its provider
group (`first_seen_in_group`), and, once that address goes missing, when it was
first and last seen missing. A banker who consents before IT adds them to the
group has no row, so the wait for the group never withdraws them. A check that
fails (`unavailable`) changes nothing, and an address back in the group has its
absence cleared. Every tick, after the flag gate, reads the provider groups of each tenant
with an active registration, whatever its sources' status (paused and halted
included). Then `discovery_withdraw_group_removed()` finds each open consent
whose address was seen in the group, has since been missing for more than 72
hours **and** was seen missing by a check within the last hour, under the provider of the banker's own mailbox
source. Once [the breaker](#group-removal) lets it through, the withdrawal purges like any other, with reason `group_removed`.
Ticks run every 5 minutes, so the hour gives twelve chances for a fresh check;
with no fresh check (a failing mirror, a stopped worker) nothing qualifies.

The grace gives an admin who mis-edits the group time to fix it: drift already
notifies the firm's admins and CCO. A banker re-added within the grace keeps the
consent; after it, the banker connects again.

**The breaker** (owner, 2026-10-17). For the pilot, every withdrawal a group
change triggers waits for the operator: the tick withdraws nothing, one
`discovery.group_removal_held` audit row a day records the counts (`due`,
`open`, `maxShare`, `minDue`), and the worker writes one line per held tenant
each tick, `{"evt":"group_removal_held","tenant":"<tenant id>","due":n}`: the
tenant id and how many withdrawals wait, no address and no content. A wrong
listing (an emptied or mis-targeted group) therefore deletes nothing.

A hold is the expected pilot state, not a failure, so it has its own
lower-severity signal and never raises the deletion-stuck alarm:

| Signal | When | What to do |
|---|---|---|
| `conductia-discovery-group-removal-held` (notice, metric `GroupRemovalHeld`) | any `group_removal_held` line in 30 minutes | check the group and release within 24 hours, as below |
| `conductia-discovery-deletion-stuck` (alarm) | a hold still unreleased **24 hours** after its oldest withdrawal fell due (72 hours of absence plus 24): the line becomes `{"evt":"group_removal_overdue","tenant":"<tenant id>","due":n}` | the same check and release, now overdue; or a failed deletion step, under [the backstop](#the-backstop) |

The 24-hour window gives the operator a working day to check the group, and
keeps a forgotten hold from leaving consent-ended mail stored indefinitely.
Both signals go to the alert topic (the owner and the CCO); the notice says
"Notice, not a failure" and sends no OK message. The general rule, kept as
configuration for after the pilot (`GROUP_REMOVAL_BREAKER` in
`src/lib/constants/discovery.ts`), holds a tenant only when more than 30% of its
open consents, and at least 3, are due at once.

When the notice (or, once overdue, the alarm) fires, find the tenant id in the
worker line and compare the group with the open consents as below. If the
group is wrong, fix it: the next successful check clears the absences. If the
removals are real, release them in the SQL editor, which withdraws, and so
purges, every consent then due, and verify with the `discovery.mailbox_purged`
count below:

```sql
select discovery_withdraw_group_removed(p_max_share => 1);
```

It returns `{withdrawn, held, holds}`: `holds` names each tenant still held,
with `due` and `overdue`.

**Known limitation, and the operator check.** Nothing checks the group while
`deal_discovery` or `discovery_worker_enabled` is off, while the tenant's
registration for that provider is not active, or while the worker is stopped
(lever 2, teardown). The live mirror cannot read a Microsoft group, so a removal
from a Microsoft group is not observed. Nothing is read in those windows either.
An absence that began in such a window counts from the first check that sees
it, so its stored mail stays up to 72 hours past the window. Before
re-enabling reads, and at pilot end (where the tenant purge covers it anyway),
compare the group with the open consents. In the SQL editor, on screen only:

```sql
select provider, address from allowed_mailboxes where tenant_id = '<tenant id>';
```

Compare that list with the group's members in the Admin console. For each
consented address no longer in the group, withdraw the consent in the SQL
editor. The same purge and audit triggers run, with reason `group_removed`:

```sql
begin;
select set_config('conductia.mailbox_withdraw_reason', 'group_removed', true);
update mailbox_consents set withdrawn_at = now()
 where tenant_id = '<tenant id>' and address = lower('<address>') and withdrawn_at is null;
commit;
```

Verify: `select count(*) from audit_log where tenant_id = '<tenant id>' and action = 'discovery.mailbox_purged' and ts > now() - interval '10 minutes'`
counts one row per banker withdrawn (none when the banker had no source).

### The backstop

At the top of every tick, **before** the flag gate, the worker runs
`discovery_collect_orphans_all()`. In every tenant it collects each message no
mailbox holds that is older than 15 minutes (the in-flight guard: the worker
writes a message before its provenance), as above. In a tenant whose policy
deletes the index on disconnect, it also deletes each index row whose mailbox
source is gone and whose deal is not under legal hold (`indexRows`). It writes
one `discovery.content_collected` audit row per tenant where something was
deleted: the run id and the collector's counts, ids and counts only. The kill
switch (lever 1) stops reading, never deletion.

A failed backstop or group withdrawal does not stop reading (owner choice,
resolved in the audit): the tick writes one content-free warn line,
`{"evt":"orphan_collection_failed"}` or `{"evt":"group_removal_failed"}`, and
carries on. The next tick tries the deletion again. A banker's own purge does
not depend on it, because it runs in the database at disconnect. A warn line
that repeats every tick means deletion is stuck: three of them, or of
`group_removal_overdue`, in 30 minutes raise the `conductia-discovery-deletion-stuck`
alarm (to the alert topic, so the owner and the CCO). A hold inside its 24
hours (`group_removal_held`) never counts. A failed accept expiry (G-02b #173) counts too:
`{"evt":"accept_expiry_failed"}` means requests a crash left behind are not being finished, so the text they
stored is not purged; the next tick tries again. Diagnose it as in
[Troubleshooting](#troubleshooting-without-message-text), or, for
`group_removal_overdue`, as under [the breaker](#group-removal).

With the worker stopped (lever 2, or after teardown) nothing runs the backstop.
Per-banker purges still run at disconnect, because they live in the database.
To collect by hand, in the SQL editor:

```sql
select discovery_collect_orphans_all();
```

It returns counts (`tenants`, `items`, `candidates`, `heldSkipped`,
`indexRows`), never content.

### Legal hold

Anything that evidences a deal under legal hold (`deal_is_under_hold`) is
skipped and counted, never deleted silently: the message, with its text and
evidence, the promoted candidate, and the index rows linked to the deal. The
count is `heldSkipped` in the audit row. The backstop retries every tick, so
held mail and its index rows go on the first tick after `lift_legal_hold`. With
the worker stopped, run the backstop by hand after the lift. The tenant purge
lists the held residue in its report, by candidate and deal, and leaves the
held index rows out of the exported index.

### Tenant purge (pilot end, or the bank's written request)

`scripts/discovery/purge-tenant.ts` writes the tenant's message index into its
report, detaches every mailbox source of the tenant (archived ones included)
through the same `discovery_purge_identifiers`, deletes the index under the
pilot policy (`index_at_tenant_end = 'export_then_delete'`), collects with the
same collector at no age guard, and deletes the mail-address caches. It runs
inside one psql transaction that rolls back unless the operator confirms, so the
dry run reports exact counts from the real statements.

| Deleted | Kept, and why |
|---|---|
| Every `content_sources` row of kind `mailbox`, with its provenance, ledger and thread taints | `mailbox_consents`: the record of who opted in and when (addresses and ids) |
| Every stored message, with its text, evidence links, milestone events and model calls | Reader registrations and exclusion policies: configuration, no mail |
| Every candidate left with no evidence, with its visibility, assessments, recompute requests and corrections | SharePoint site content: out of G0's scope |
| Stage assessments that cite a deleted milestone | `deals` and `deal_steps`: what the MD typed |
| `mailbox_guard_state` rows for mail addresses, `mailbox_allowlist_drift`, `mailbox_group_absence` | `audit_log`: append-only, addresses and ids, never content |
| The tenant's `discovery_message_index`, after it is written to the report (pilot policy) | `notifications` (`mailbox_connected` names an address) and `ai_usage` (model, tokens, cost) |
| | `tenant_retention_policies`: the policy, no mail |
| | pg-boss jobs (ids only, gone within 7 to 14 days) and CloudWatch worker logs (ids, codes and counts, 365 days) |
| | Anything under legal hold, listed in the report |
| | The message index, when the policy says `index_at_tenant_end = 'keep'` |

Steps, as admin, from the repository root:

0. **Mark the tenant.** Set its lifecycle to `decommissioning`, as
   [Retention policy](#retention-policy) shows. Nothing reads the lifecycle; the
   report shows it, and the audit log records when the tenant entered its end.
   Check `index_at_tenant_end` at the same time: the pilot value,
   `export_then_delete`, is what G0 promises.

1. **Stop reading.** At pilot end, stop the worker first (step 15, item 1). Then
   set every reader registration of the tenant to `disabled`, in the SQL editor.
   The script refuses while any registration of the tenant is active
   (`reader_registration_active`):

   ```sql
   update google_reader_registrations set status = 'disabled' where tenant_id = '<tenant id>';
   update graph_reader_registrations  set status = 'disabled' where tenant_id = '<tenant id>';
   ```

2. **Dry run.** It needs psql 15 or later (an older psql prints only the last
   result, and the script refuses it) and `DATABASE_URL` naming the hosted
   project as `postgres` through the session pooler, in an env file under
   `~/conductia-secrets/`. `--env-file` does not override a `DATABASE_URL`
   already exported in the shell, so unset any first:

   ```bash
   unset DATABASE_URL
   node --env-file=$HOME/conductia-secrets/<purge env file> --import tsx scripts/discovery/purge-tenant.ts --tenant <tenant id>
   ```

   The first line names the target (`host[:port]/dbname`). Stop if it is not the
   project you mean. A dry run rolls back and deletes nothing. It writes its
   report (step 3) and prints, on its last line, the exact `--from-dry-run` path
   that step 4 needs. Running the dry run a second time and comparing the counts
   by eye is a check for you; it guards nothing. The guard is in step 4.

3. **Read the report.** One JSON and one Markdown file per run, mode 0600, never
   overwritten, in `~/conductia-purge-reports` (or `--out <dir>`). The script
   checks the directory before any database work and stops, purging nothing,
   when it cannot write there or a report of that name exists. A directory
   inside the repository is refused, because the report lists the Message-ID hashes of
   the bank's deleted mail. Its header names the lifecycle and what happens to
   the message index. It holds, per purged table, the rows before, after, kept
   under legal hold, and kept by the retention policy (the index, under
   `index_at_tenant_end = 'keep'`), the two kept columns apart; what was deleted, by kind (`sources`, `provenance`,
   `ledger`, `taints`, `indexRows`, `items`, `texts`, `evidence`, `milestones`,
   `modelCalls`, `candidates`, `corrections`, `heldSkipped`, `guardRows`,
   `driftRows`, `absenceRows`, `budgets`); the SharePoint site counts before and after,
   which must be equal; the section **Message index for the bank**, one row per
   message per mailbox (Message-ID SHA-256, provider ids, mailbox source id, sent date,
   deal, tags, rules, model and prompt versions, processed date; no subject,
   body or address); the held residue; and the audit row id (rolled back in a
   dry run).

4. **Commit.** A commit is built on a dry run. Read the dry run's report first
   (step 3), announce the window to the CCO, then pass the dry run's JSON report
   (the path its last line printed) to the commit:

   ```bash
   node --env-file=$HOME/conductia-secrets/<purge env file> --import tsx scripts/discovery/purge-tenant.ts \
     --tenant <tenant id> --commit --confirm-tenant <tenant id> --from-dry-run <dry run report .json>
   ```

   `--commit` is refused without `--from-dry-run`. The script checks, before any
   database work, that the report is a dry run of this tenant against the same
   target (`host[:port]/dbname`) and holds a fingerprint (an md5 over the counts
   and the result), and that it can write its own report. It then makes its own
   rollback read pass and compares that pass's fingerprint with the dry run's.
   When they differ, the tenant has changed since the dry run, the commit is
   refused, and nothing is committed: read a new dry run and start again. This
   comparison is the guard. It does not depend on you comparing counts.

   The commit transaction then refuses, and commits nothing, when its own
   fingerprint differs from the read pass's (`fingerprint_mismatch`), when a
   purged table keeps a row legal hold or the retention policy does not explain
   (`purge_incomplete`), or when a site count changed (`site_changed`). A
   committed run writes one `discovery.tenant_purged` audit row (service
   identity `purge-tenant`, ids and counts only). The purge function runs as the
   database owner connection; no API role, `service_role` included, can execute it.

   **What a failure leaves.** The report is on disk before anything commits: the
   read pass is written to `.pending` files (exclusive create, 0600, flushed),
   with `null` run and audit ids because the commit's own are not known yet. The
   pending Markdown says `Pending: not yet confirmed`; only a finalized report
   says `Committed. The rows below were deleted.` The cases differ.

   - **A refusal or an error before the commit.** Nothing is purged and the
     script exits non-zero, usually saying `Nothing was committed`. This covers a
     dry run report that does not match, an active reader registration, a
     changed fingerprint, a report that cannot be written and a commit
     transaction that fails with a server `ERROR` (Postgres never commits a
     transaction that raised); in that last case it also deletes its `.pending`
     files.
   - **The outcome is unknown.** A commit pass that fails without a server
     `ERROR` (the connection dropped, psql was killed or its output overflowed)
     may have reached COMMIT. The script keeps the `.pending` files, prints
     `OUTCOME UNKNOWN`, exits 1 and prints the next command. It is the same
     when the commit's output is unreadable after the commit. Do not purge the
     tenant again.
   - **A failure after the commit.** The deletion has happened and cannot be
     undone. The script exits 1 with `Committed, but ...` and keeps the
     `.pending` files.

   In the last two cases keep the `.pending` files and never rerun the purge to
   recover: a second run finds nothing left to purge and would write a report of
   zero counts, which is not the report of this deletion. Settle the report with
   `--resolve`, from the same environment as the commit:

   ```bash
   node --env-file=$HOME/conductia-secrets/<purge env file> --import tsx scripts/discovery/purge-tenant.ts \
     --tenant <tenant id> --resolve <the .pending.json path the script printed>
   ```

   It refuses a report of another tenant or database, one that already holds
   committed ids, or one whose final files already exist. Otherwise it looks for
   the `discovery.tenant_purged` audit row of the tenant written at or after the
   report's `startedAt` whose counts equal the report's `deleted` counts. On
   exactly one match it writes that row's `auditId` and `runId` into the report
   and gives the files their final names, and the report then says `Committed`.
   On none or on several it refuses, says the outcome stays unknown and leaves
   the pending report intact: do not finalize it by hand and do not purge the
   tenant again; take it to the owner. `--resolve` also refuses when the
   operator's clock ran ahead of the database's, because the audit row then
   predates `startedAt`; escalate that too. If the script instead printed
   `Committed, but the report could not be finalized` with an audit row id, the
   pending report already holds the committed ids, so `--resolve` refuses it.
   If `<report>.pending.json` still exists, check its `auditId` against the
   printed one and rename both `.pending` files to their final names. If only
   `<report>.pending.md` remains (the JSON was renamed and the Markdown rename
   failed), check the final `<report>.json`'s `auditId` and rename the `.md`
   alone.

5. **The written confirmation.** Draft it from the committed report's Markdown:
   the date, the counts, the message index (Message-ID SHA-256 and sent date, which the
   bank matches against its own archive by hashing its Message-IDs, and the deal each message evidenced),
   any held residue with its deal, and the date the deleted data leaves the
   backups ([Backups and restores](#backups-and-restores)). Send it through the
   channel the bank named, encrypted in transit and at rest (the report lists
   every Message-ID hash; never plain email). Proposed, for the owner to confirm:
   once the bank acknowledges it, the operator who ran the purge deletes both
   report files and records the date, their name and the file names in the
   deployment record, which keeps the audit row id and the counts. Under the
   pilot policy, the copy the bank received is then the only copy of the index.

Verify: a dry run after the commit shows zero in every "After" column except
rows kept under legal hold (and the index, when the policy keeps it), and
`select count(*) from audit_log where tenant_id = '<tenant id>' and action = 'discovery.tenant_purged'`
is at least 1. The exported index is exactly the index rows the purge deleted
(plus those the policy keeps): the purge locks the mailboxes before it reads
the index, so a page in flight is either in both or in neither. Record the
audit row id and the report's file names in the deployment record.

The index travels as one JSON value. At pilot scale (about 51,000 rows, about
25 MB) that is far inside the limit Postgres sets on one JSON value (about
256 MB); a tenant near a million indexed messages needs the export streamed
first.

**After a tenant purge, consents stay open but no mailbox source remains.**
Re-enabling a registration in that state means:

- SharePoint sites with an open registration are read again on the next tick:
  their sources survived.
- No mailbox is read. The guard refuses each consented address `no_source`, and
  Profile does not say the mailbox is being read. **Connect my mailbox** does
  not change that: the consent is still open, and an open consent creates no
  source.
- A banker's mailbox is read again only after the banker selects **Stop reading
  my mailbox** (the withdrawal is audited; with no source, nothing is purged)
  and then **Connect my mailbox**, which creates a fresh source. Its first pass
  reads the mailbox from the start, so mail the purge deleted is read and stored
  again.

So at pilot end the registrations stay `disabled`. Proposed: re-enabling after a
purge is a new decision, recorded by the owner with the bank's written
agreement, because it stores again mail the confirmation says was deleted. Run
the [group check](#group-removal) before re-enabling.

### Decommissioning a tenant

Owner decision (owner, 2026-10-14): a tenant is decommissioned by the tenant
purge, then project deletion. Nothing beyond the purge is built for it.

1. Set the tenant's lifecycle to `decommissioning`
   ([Retention policy](#retention-policy)).
2. Run the [tenant purge](#tenant-purge-pilot-end-or-the-banks-written-request)
   to the end: dry runs, the commit, and the written confirmation.
3. Delete the project. Proposed reading, for the owner to confirm: the hosted
   Supabase project that holds the tenant's data. Deleting a Supabase project
   removes its database and its backups, the one documented way to take deleted
   rows out of the backups before they age out. That fits a project that holds
   no other tenant. While the project holds other tenants it stays, and the
   tenant's deleted rows leave the backups as
   [Backups and restores](#backups-and-restores) states.

The purge comes first because it writes the audit row, the counts and the
message index the bank's confirmation is drafted from; a deleted project can
produce none of them. Record the purge's audit row id and the date of the
project deletion in the deployment record.

### Backups and restores

Proposed; the number is an owner item. Supabase offers no row-level purge of
backups. A deleted row stays in the physical daily backups until they age out,
or in the point-in-time recovery (PITR) archive until its window passes: daily
backups are kept 7 days on Pro, 14 on Team and up to 30 on Enterprise; PITR,
when enabled, keeps 7, 14 or 28 days and replaces the daily backups. The hosted
project's plan is `<plan: owner item>`, so deleted mail leaves the backups
within `<N: owner item>` days of its deletion. Discovery stores no mail in
Storage, whose objects are outside database backups.

**After any restore.** A restore brings back every row deleted after the restore
point (stored mail, index rows, the consents withdrawn since then, and any
retention policy written since then), and their audit rows go with them. Until
the purges are applied again, keep the worker stopped (lever 2) and the
tenant's registrations `disabled`.

1. Before an in-place restore (or from the old project, after a restore to a new
   one), list the consent ends, policy changes and tenant purges recorded after
   the restore point, ids, reasons and policy values only:

   ```sql
   select ts, action, detail->>'consentId' as consent_id, detail->>'reason' as reason,
          detail->'new' as policy
   from audit_log
   where tenant_id = '<tenant id>' and ts > '<restore point>'
     and action in ('discovery.mailbox_consent_withdrawn', 'discovery.retention_policy_set',
                    'discovery.tenant_purged')
   order by ts;
   ```

2. On the restored database, write each listed policy change again first
   ([Retention policy](#retention-policy)), with the values in `policy`, so the
   purges below apply the policy the tenant had.
3. Withdraw each listed consent again with its reason.
   The purge trigger deletes its mail again:

   ```sql
   begin;
   select set_config('conductia.mailbox_withdraw_reason', '<reason>', true);
   update mailbox_consents set withdrawn_at = now() where id = '<consent id>' and withdrawn_at is null;
   commit;
   ```

4. Run the tenant purge again (steps 0 to 4 above) for each tenant purged after
   the restore point.
5. Collect what remains: `select discovery_collect_orphans_all();`

Verify: the restored database holds a `discovery.mailbox_purged` row for each
consent withdrawn again, and a `discovery.tenant_purged` row for each tenant
purged again. Record the restore and the purges applied again in the deployment
record.

### Proposed G0 wording

Not an edit to G0, which is the owner's document (step 7). The owner adopts or
edits this wording, fills in the two numbers, and co-signs it with the CCO.

> **9. Deleting stored mail.** Conductia deletes a banker's stored mail
> content, and everything derived from it, when the banker disconnects their
> mailbox, withdraws consent, loses their seat, or is removed from the ingest
> group (after a 72-hour grace for group removal). Content is the subject, body,
> excerpts, participant names and addresses, and the names proposed for a deal.
> Mail a colleague's connected mailbox also holds stays with theirs. A mailbox
> source that an earlier holder of the same address left archived is not
> deleted when this banker disconnects. It is deleted when Conductia deletes
> the tenant's stored mail, at the end of the pilot or on Ignatious's written
> request. Conductia
> keeps an index of the messages it processed, holding no subject, body,
> participant or address field (a SHA-256 of the Message-ID, provider id, sent date, a content
> digest keyed per tenant, deal link, category tags and processing versions) only as Ignatious's retention policy states. For this pilot the
> index of a banker's mailbox is deleted when the banker's mail is, and at the
> end of the pilot, or on Ignatious's written request, Conductia deletes all
> stored mail and mail-derived data of the tenant, hands Ignatious the index of
> the messages it processed, then deletes the index, and confirms it in writing.
> Each deletion completes within `<30>` days of its trigger. Anything that
> evidences a deal under legal hold is kept until the hold is lifted, and the
> confirmation names it. Deleted data leaves Conductia's database backups within
> `<N>` days. The audit log is append-only and keeps the addresses and ids of
> these events, never message content or a Message-ID. SharePoint site content
> is not mail and is outside this item. The procedure is
> [Deleting stored mail](#deleting-stored-mail).

What happens in practice, for the owner's reading of the window: a per-banker
purge completes at disconnect; a page in flight is collected within one tick
plus 15 minutes; a group removal purges 72 hours after the first check that saw
it; held mail and its index rows go when the hold lifts; and the tenant purge
completes when the operator commits it. No code parameter depends on the 30
days. A change to the tenant's retention policy that keeps content or the index
longer than the pilot values is a change to this commitment, so it needs the
bank's written agreement before it is written (Proposed).

## Blast radius under P1 = A

G0 (step 7) signs this section. It states what a compromised task, or anyone
holding `deploy`, could reach.

**Reachable:**

- **Hosted project data:** read and write every row of every table in every
  tenant, through PostgREST as `service_role`, with RLS bypassed. That includes
  other tenants' deals, document metadata, `audit_log` inserts, the discovery
  tables and mail texts.
- **Database functions:** every `service_role`-granted definer RPC.
- **Auth:** the Supabase Auth admin API: create, delete or impersonate users, and
  issue magic links.
- **Storage:** read and write every bucket, the `dataroom` included.
- **Queue:** through `discovery_queue`, insert, alter or delete `pgboss` jobs (for
  example, forcing extra sync jobs). Nothing in `public`.
- **Google, the whole domain:** domain-wide delegation covers every mailbox in
  Ignatious's Workspace domain. A compromised task can mint a `gmail.readonly`
  token for any `sub`, not only the allowlisted ones: the allowlist and the #262
  guard are code inside the task, and a compromised process skips them. It can
  also read the membership of every group `sa-directory` can see. The only
  Google-side limits are the delegated scope (`gmail.readonly`: no write, no
  send) and the federation condition (step 8).
- **Egress:** the task can open a connection to any host on tcp 443 or 5432, so a
  compromised task can send what it reads to any host on 443.

**Who else holds this reach.** The `deploy` role registers no task definition
(OpenTofu does, as admin), but it can run the `probe` or `once` family with a
command override, which then runs any code the image holds under the four
secrets and the task role. Holding `deploy` is therefore equivalent to holding
the secrets and the Gmail identity. It is guarded as such: named principals, MFA
(or Identity Center MFA under SSO), a one-hour session, and every use alerts the
owner and the CCO. IAM scopes what it can name, not what a call carries:
`RunTask` is limited to the `probe` and `once` families on this cluster, but no
IAM condition key restricts a `RunTask` override (the AWS Service Authorization
Reference for ECS, checked 2026-10-04). `iam:PassRole` names both worker roles,
because `RunTask` passes the task definition's task and execution roles; an
override that names the execution role (which can read the secrets) as the task
role is a `taskRoleArn` override. The `ecs-task-overrides` and `ecs-operation`
alerts are the control there, and G8 tests the overrides alert once.

**A recorded residual G0 signs:** the `ecs:UpdateService` that scales a service
to zero (lever 2) can also scale it up, IAM having no condition key on the
desired count. A scale-up by `deploy` outside step 13 pages on `ecs-operation`,
and the next apply reverts it to the tfvars count (no `ignore_changes`).

**Not reachable:** the database as superuser or owner, and any DDL; the Supabase
management API or dashboard; Vercel and its environment, GitHub, and other AWS
accounts; any Gmail write or send scope.

**Egress residuals:**

- 5432 is open to any address, because the session pooler has no fixed range.
- The DNS Firewall allowlist sees names, not connections: a connection to an IP
  literal on 443 or 5432 is not blocked. VPC flow logs and GuardDuty are what
  would show it.
- There is no FQDN filtering on connections. AWS Network Firewall is added only
  on a bank's written request (ADR-0020 decision 6).

**Detection:** the Supabase organisation audit log (a key reveal); CloudTrail
alerts on `GetSecretValue` by an unexpected principal, any use of `deploy`, and
any `AssumeRole` of the task role not made by ECS; GuardDuty runtime monitoring,
VPC flow logs, Resolver query logs and DNS Firewall hits; and in GCP, the IAM
Credentials data-access log on `signJwt` (a record, not the alert); the
out-of-list token alert reads the Workspace token audit via Reports under the
alert identity (#674), not that log.

**Containment:** deleting the `discovery-worker-aws` key cuts REST access in
seconds. Removing the principalSet bindings stops new Google tokens. Tokens
already minted stay valid for up to one hour: fully dark is the last lever plus
up to one hour.

## Troubleshooting without message text

The worker and the probe print codes, never error text. Every line is one JSON
object (`{"evt":"tick"|"sync"|"discover"|"queue_error"|"fatal",…}`, or the
probe's `{"evt":"probe_error","reason":<code>}`). A failed tick prints
`{"evt":"tick","status":"failed","reason":<code>}`. A startup that fails on
configuration prints only `{"evt":"fatal","reason":"Worker error"}`. Diagnose
from the outside, never by adding output:

- **The task never started:** `aws ecs describe-tasks … --query 'tasks[0].stoppedReason'`.
  A `ResourceInitializationError` names the secret or parameter ARN the
  execution role could not read; check its `list-secret-version-ids` (an empty
  container fails the task) and the execution role's policy.
- **`fatal` with `Worker error`:** check the names the task definition injects,
  never the values:
  `aws ecs describe-task-definition --task-definition conductia-discovery-<family> --query 'taskDefinition.containerDefinitions[0].[environment[].name,secrets[].name]'`.
  Then the usual causes, each checkable without the value: the Supabase key's
  prefix (step 3; a legacy JWT key is refused in production), the queue URL
  (step 4's `psql` check, from your machine), and the workload identity configs
  (step 8's `type` check).
- **The image itself:** on your machine, with no secret,
  `docker run --rm --read-only --mount type=volume,dst=/tmp -e GOOGLE_WIF_DWD_CONFIG='{"type":"external_account"}' -e GOOGLE_WIF_DIRECTORY_CONFIG='{"type":"external_account"}' conductia-discovery-worker:<tag> self-check`
  prints a non-zero uid and mode 600 for both config files.
- **Probe codes:** `arg_*` is the command or the parameters (a malformed value in
  an SSM parameter reads `arg_malformed_address`; a missing parameter stops the
  task before it starts, with a `ResourceInitializationError`); `registration_not_found`
  means no active Google registration for the tenant (step 9); `secret_key_shape`
  is the Supabase key; `out_of_scope_not_registered` means the out-of-scope
  account is a user, an invitee, allowlisted, a mailbox source of the tenant,
  the persona or off-domain; `guard_unavailable`, `source_lookup_failed` and
  `out_of_scope_lookup_failed` mean the database could not be asked. In
  production (`NEXT_PUBLIC_APP_ENV` `prod` or `production`, any case) any run
  that asks the guard, the laptop `--guard-db` run included, refuses a key that
  is not an `sb_secret_` key.
- **Sync reasons** are the admin's `last_error` codes: `Worker error`,
  `Database error`, `Google delegation refused`, `Google <status> <reason>`,
  `Checkpoint unreadable`, or a guard refusal reason. The `/discovery` Ingestion
  health panel shows the same codes per source.
- **An alert:** its body names the rule, the event name, the principal, the time
  and the CloudTrail event id (or the GuardDuty finding id), never the request.
  Open the id in CloudTrail › Event history or in GuardDuty for the full record.
  Inside an announced window it is expected; outside one it is an incident
  (step 14).
- **A task stuck in provisioning after the DNS move:** a platform name is
  missing from the allowlist. The query log names it (step 10, item 6); add it to
  `dns_allowlist` and apply.
- **The address alarm:** a code path printed an address. Find the line by the
  alarm's time window in the worker log group, never by searching for an
  address, then treat it as an incident (step 14) and fix the code path.

## Stopping partway

Before step 13 no service runs a task. To leave the account inert at any point
before the go-live gates (from step 13 on, use the kill switch in step 14):

- Before step 8, nothing can mint a Google token: the workload identity secrets
  are empty and no delegation grant exists.
- From step 8: Ignatious's admin removes the domain-wide delegation entry, and
  the kit's T+0 removes the principalSet bindings and disables `sa-dwd`.
- From step 3: delete the `discovery-worker-aws` key in the dashboard.
- From step 4: rotate the `discovery_queue` password in the SQL editor.

Verify: `aws ecs describe-services --cluster conductia-discovery --services conductia-discovery-classify conductia-discovery-extract --query 'services[].runningCount'`
prints 0 and 0.

## Switching later

The provisional owner calls of G0 can change without restructuring the module.

- **P1 = A to B or D.** B (a scoped role over REST with an owner-minted JWT) or D
  (#264's pull-only API) changes what `SUPABASE_SECRET_KEY` holds and where the
  worker sends it. Put the new credential into a new secret from a file, set
  `worker_supabase_secret_name` to that secret's name, and land the code the
  option brings (#264 for D). G0, G4 and G10 (lever 3) are signed again before the
  new credential reaches real mail.
- **P2 = A to B** (after the owner's D-entry for the ADR-0017 gateway row). It needs
  #325 merged, so the image builds `extract`:
  1. A reviewed code PR flips `VERIFIED_MODEL_PROCESSORS`,
     `DISCOVERY_OUTPUT_PLACEMENT_APPROVED` and `VERIFIED_MODEL_TENANT_IDS` (the
     Ignatious tenant id, the same value as `probe_tenant_id` in the tfvars), sets the
     row to Yes and adds the D-entry. The prerequisites in that row come first.
     **Do not set `extract_gateway_enabled = true` before this PR is deployed:** the
     gate refuses `not_local`, the worker exits, and ECS restarts it in a loop. No
     mail is read, but the loop is noise.
  2. A new build at a commit holding that PR and #325 (step 5), then stage 2
     again (step 6) and the gates its rebuild rule names.
  3. The owner puts the gateway key into `ai-gateway-api-key` from a file.
  4. **Read the estimate.** As `deploy`, run the estimate task as defined, with no command override,
     then read its one JSON line as admin:

     ```bash
     export AWS_PROFILE=<deploy profile>
     aws ecs run-task --cluster conductia-discovery --task-definition conductia-discovery-estimate \
       --launch-type FARGATE --count 1 \
       --network-configuration 'awsvpcConfiguration={subnets=[<private subnet a>,<private subnet b>],securityGroups=[<security group id>],assignPublicIp=DISABLED}' \
       --query 'tasks[0].taskArn' --output text
     aws ecs wait tasks-stopped --cluster conductia-discovery --tasks <task arn>
     aws ecs describe-tasks --cluster conductia-discovery --tasks <task arn> \
       --query 'tasks[0].[stoppedReason,containers[0].exitCode]'
     aws logs get-log-events --log-group-name /conductia/discovery-worker --profile <admin profile> \
       --log-stream-name estimate/worker/<task id> --query 'events[].message' --output text
     ```

     The line gives:
     - item and thread counts;
     - body and subject byte total, mean, median, p95 and max;
     - expected input and output tokens and cost, the ceiling cost (input at the
       ceiling's own 2.0 bytes per token, 2048 output tokens per item), and the stop line;
     - the assumptions, including `bytesPerToken` for the expected cost and
       `ceilingBytesPerToken` for the ceiling.

     It returns no body and calls no model. Record the numbers in the deployment
     record.
  5. In the tfvars file, with `start_approved` already true from step 13 (the
     extract service's precondition requires it):

     ```hcl
     extract_gateway_enabled = true
     extract_desired_count   = 1
     ```

     Announce the window and apply. Lever 2 then also covers the extract
     service (step 14). The same apply creates the
     `conductia-discovery-extract-no-running-task` alarm. A ZDR stop restarts
     the task, so read that alarm with the AI-off search of the
     [app observability runbook](./app-observability-runbook.md) (steps 3
     and 5). The extract task runs
     `extract --tenant <tenant id> --transport gateway` (the tenant is `probe_tenant_id`; the fixed command arrives with #433), and the entrypoint adds
     `--serve`. A tenant the code does not list refuses `tenant_not_verified` and reads
     nothing. The first pass computes a **fresh** estimate, opens the budget and prints
     it as `{"estimate":...}`. Compare it with step 4's line: the counts and cost should
     match, apart from mail that arrived in between. If they differ materially, scale
     to 0 and decide before going on.
  - **One worker at a time, enforced.** Every send is reserved in the database under
    the budget's row lock (`discovery_extract_reserve`), which checks the stop line
    against every process's spend and reservations. A manual gateway `--once` beside
    the service therefore cannot overspend, re-send an answered item, or retry a failed
    one sooner or more often than the batch allows (30 seconds apart, at most three
    attempts): whichever process finds a call in flight, or an item the batch would not
    select now, stops with `"capped":"busy"`. Still run one at a time; a
    `busy` stop is wasted work, not a fault.
  - **Budget renewal and stops.** The run extracts only the cohort the budget
    counted, so mail that arrives later waits. Each summary line carries `capped`,
    which is null while the run is sending.
    - `"capped":"over_estimate"`: the next call's ceiling would cross the stop line.
      Nothing more is sent, and corrections are still answered every 3 seconds.
      Whether to continue is the owner's decision. To continue, or to extract mail
      that arrived later, the owner closes the budget in the SQL editor:

      ```sql
      update discovery_extract_budgets set closed_at = now() where tenant_id = '<tenant id>' and closed_at is null;
      ```

      Run the estimate task first and read it. The next pass opens a fresh estimate
      over what is then pending.
    - `"capped":"unpriced"`: a cost is not on the ledger as a number. The causes are
      a reply with no usage, no response id or no price (the run writes a null-cost
      ledger row); a ledger write that failed (a call row with no ledger row); a
      call-row write that failed after the ledger write (a priced ledger row with no
      call row); and a reservation never settled (a cohort row with `inflight_since`
      set: a crash, a `SIGKILL` or a failed write mid-call, whose outcome is unknown, so
      it counts at its ceiling). A reservation left by an earlier pass reports `unpriced`
      at the start of the next pass, before any call; `busy` describes a reservation
      refused during the current pass. Find the rows before renewing. In the SQL editor, ids and numbers
      only; never select body text:

      ```sql
      -- ledger rows since the budget opened with no cost, or matching no gateway call
      select u.id, u.external_id, u.cost_usd, u.created_at
      from ai_usage u
      join discovery_extract_budgets b on b.tenant_id = u.tenant_id and b.closed_at is null
      where u.tenant_id = '<tenant id>' and u.source = 'discovery_extract' and u.created_at >= b.opened_at
        and (u.cost_usd is null
             or not exists (select 1 from model_calls c
                            where c.tenant_id = u.tenant_id and c.transport = 'gateway'
                              and c.created_at >= b.opened_at and c.response_id = u.external_id));

      -- gateway calls since the budget opened that settled with no ledger row
      select c.id, c.source_item_id, c.outcome, c.created_at
      from model_calls c
      join discovery_extract_budgets b on b.tenant_id = c.tenant_id and b.closed_at is null
      where c.tenant_id = '<tenant id>' and c.transport = 'gateway' and c.outcome in ('ok', 'invalid')
        and c.created_at >= b.opened_at
        and not exists (select 1 from ai_usage u
                        where u.tenant_id = c.tenant_id and u.source = 'discovery_extract'
                          and u.created_at >= b.opened_at and u.external_id = c.response_id);

      -- cohort rows reserved and never settled
      select bi.source_item_id, bi.ceiling_usd, bi.inflight_since
      from discovery_extract_budget_items bi
      join discovery_extract_budgets b on b.id = bi.budget_id and b.closed_at is null
      where b.tenant_id = '<tenant id>' and bi.inflight_since is not null;
      ```

      The first query finds the null-cost rows and the priced rows with no call. The
      second finds the calls with no ledger row. The third finds the reserved items:
      for each, look in the gateway dashboard for a call near `inflight_since`. Read
      what each row is, price it from the gateway dashboard if the owner needs the
      true spend, and only then close the budget as above. Closing the budget without
      that read hides the fault.
    - No `capped` value with `"selected":0` while a budget is open: the cohort has no item
      left to send (all answered, or the rest are inside their retry wait). This is a
      completed or waiting cohort, not a fault; the owner closes the budget as above to
      open a fresh estimate.
    - `"capped":"budget_model_mismatch"`: the open budget was opened for another model or
      prompt version than the one this build runs. Nothing is sent. The owner closes the
      budget as above; the next pass opens a fresh one under the running model and prompt.
      To see which pair the open budget holds:

      ```sql
      select id, model, prompt_version, opened_at from discovery_extract_budgets
      where tenant_id = '<tenant id>' and closed_at is null;
      ```
    - `"capped":"busy"`: another process has a call in flight on this budget, or the
      item was answered since the opening, or its last failure is under 30 seconds old
      or it has failed three times. Nothing is sent; the next
      pass continues. If it repeats with only one worker running, a reservation was left
      set by a crash: read it as for `unpriced`.
    - `"capped":"closed"`: the budget was closed while the pass ran. Nothing more is sent;
      the next pass opens a fresh one.
    - `"capped":"no_budget"`: mail is pending, but the pending set changed between the
      estimate and the opening, so no budget opened. Nothing is sent; the next pass
      estimates again. `"capped":"not_in_cohort"` means a caller asked to reserve an item
      outside the cohort, which the batch never selects: report it as a bug.
    - **What the ceiling assumes.** Each call's ceiling assumes at least 2.0 bytes per
      input token (`ceilingBytesPerToken` in the estimate) and 2048 output tokens. Each
      call's real usage is ledgered before the next check, and output is capped at 2048
      tokens, so content that tokenizes denser than 2.0 bytes per token (long base64 or
      URL runs) can overshoot the stop line by at most one call's excess input cost.
- **`DWD_SIGN_MODE` from `direct` to `self`** (G7). The Ignatious admin reruns the
  kit with `DWD_SIGN_MODE=self`; the new DWD config goes into
  `google-wif-dwd-config` as in step 8; `check-gcp-policy.ts --mode self` must
  print `PASS`; then a forced redeploy (step 14) and the probe (step 10).

Verify: after any switch, the deployment record names the switch, its date, the
gates signed again and the probe or run that proved it.

## Demo only: the coverage count and the model proposal run (#460)

Proposed ([D91](../07-decisions/decision-log.md), not yet approved). Neither part
is a numbered step or a gate, and neither starts the worker: both come after
step 13. The coverage count needs a build that holds `[460 1/6]`; the propose
run needs the whole `[460 1/6]` to `[460 6/6]` stack. Every line either run
prints is UUIDs, integers and fixed words: record it in the deployment record,
which stays private.

### The coverage count (no AI)

It answers one question for the owner's go or no-go: does Ignatious's mail name
its deals with codenames often enough to demo on the rules alone? Extract stays
at zero throughout: `classify-once` never extracts, and `extract_desired_count`
keeps its default, 0.

1. Precondition: the count is the first read of the newly connected inbox. Once
   the classify service runs (from 13.1), turn `discovery_worker_enabled` off
   (lever 1) before the inbox's owner selects **Connect my mailbox** (13.3,
   item 4), so the service queues no sync for the new source:

   ```sql
   update feature_flags set enabled = false where key = 'discovery_worker_enabled';
   ```

   `classify-once` checks only `deal_discovery`, so the next item still reads.
2. As `deploy`, run the `once` family exactly as step 11, item 5 runs it, and read
   its log as admin. Step 11's one-allowed-mailbox stop rule does not apply here:
   `once` reads every allowed mailbox of the tenant, the persona's included.
3. Read the `Routing (…)` clause of the summary line:
   `of N read, routed N, unrouted N, skipped N, collisions N; codenames N`.
   Routed, unrouted, skipped and collisions add up to read; `codenames` is how
   many distinct codenames were routed. The owner compares it with the deals the
   team expects.
4. Read the label. `(full read)` means every source was read whole: that line is
   the answer. `(new mail only since the last pass)` means some source the run
   read had been read before. After 13.1 that is always true of the persona's
   source while it stays allowlisted, so the label reads this way even when the
   new inbox was read whole; the counts are then the new inbox plus the other
   sources' new mail. For a clean full read, run `once` again with the container
   command `classify-once --tenant <tenant id> --recount`, written as the G8
   exception run is in step 12, under a new owner approval recorded first. IAM
   cannot condition `RunTask` on a command override, so it fires the overrides
   alert by design: announce the window and record the alert. `--recount` leaves
   each source's sync cursor and resume state untouched (`delta_checkpoint`,
   `backfill_*`, `last_synced_at`, `last_error`); only the `reader_progress_at`
   liveness mark moves, as on any read. The service later resumes where it was.
5. Turn `discovery_worker_enabled` back on (the 13.1 statement, `enabled = true`).

Verify: the summary line, its label and the run id are in the deployment record,
and an override run, if any, has its approval and its alert recorded beside it.

### The propose run (only after the owner's go)

Preconditions, each in the deployment record before anything changes:

- The owner's go, from the counts above.
- Ignatious's written confirmation of zero data retention, and a separate signed
  approval for AI on their mail (#261).
- A gateway plan that accepts the ZDR flag. The step always sends it; bake-off A's
  flag-mode probe was refused with `zdr_plan` on the Hobby plan.
- A reviewed code change, never merged to `develop` as shipped, that lists the
  tenant in `MODEL_PROPOSAL_TENANT_IDS` and opens the processor gate's verified
  path for it. Without it the run prints
  `Tenant <tenant id>: propose refused (not_local).` and reads nothing; with the
  flag below off it prints `propose refused (flag_off)`.
- An image built at a commit that holds the stack and that change (step 5), then
  stage 2 again (step 6) and the gates its rebuild rule names.
- The gateway key in `ai-gateway-api-key`, put from a file as in "Switching
  later", P2 = B, item 3.
- The presenter is the owner of the connected mailbox. Only that user sees the
  "Proposed from mail by a model" section on `/discovery`; the CCO and every
  other colleague see none of it.

Then:

1. Turn `discovery_worker_enabled` off (lever 1), so the service and the run never
   read one source at once. Overlap would be safe (every write is an idempotent
   upsert), only wasteful.
2. Turn the step's flag on. No migration creates its row, so a plain `update`
   changes nothing and the run prints `propose refused (flag_off)`; insert it:

   ```sql
   insert into feature_flags (key, description, enabled)
   values ('discovery_model_proposals_demo', 'Demo-only model proposal step (#460, D91)', true)
   on conflict (key) do update set enabled = true;
   ```

3. In the tfvars file, set `propose_gateway_enabled = true` and add
   `"ai-gateway.vercel.sh"` to `dns_allowlist`, beside its existing entries: the
   name is outside the DNS Firewall baseline, and under `BLOCK` the call fails
   without it. Plan and apply as admin. The plan shows the
   `conductia-discovery-classify-propose` family, its entry in deploy's
   `RunTheProbeAndOnceFamilies` statement, the execution role's read of
   `ai-gateway-api-key` and the allowlist line, and nothing else.
4. As `deploy`, run the family as step 11, item 5 runs `once`, with
   `conductia-discovery-classify-propose` in place of `conductia-discovery-once`
   and no override: its command is fixed,
   `classify-once --tenant <probe tenant id> --propose`. Its log stream is `classify_propose/worker/<task id>` in the
   same log group. Lever 2 stops it like any task of the cluster.
5. Read the line: `Routing (full read): …`, then
   `Proposed: called N, deal N, new names N, not deal N, failed N, invalid N, cost $X, sources skipped N, sources refused N.`
   `sources skipped` counts the team inboxes and ownerless mailboxes the step did not read, and `sources refused`
   the sources the database refused before any model call (a team inbox the switch, its allowlist or a busy pass
   stopped, or a person's mailbox no longer on the allowlist); both are numbers, never ids. No deal name reaches the log. If `failed` is above zero, run the family again: messages already answered in a mailbox are
   skipped there, so only the failed ones are asked again. A message in two mailboxes is asked once per
   mailbox, from that owner's own deals. A line ending
   `Stopped after 20 failed calls in a row; nothing after them was asked.` means the gateway refused or was
   down: check the key, the plan and the allowlist line before running it again.
6. Set `propose_gateway_enabled = false`, remove the allowlist line unless the
   extract service needs it, and apply as admin. The family, deploy's `RunTask`
   on it and the execution role's read of the key go with it. Revoke the key at
   the gateway if nothing else uses it.
7. Turn `discovery_worker_enabled` back on.

Leave `discovery_model_proposals_demo` on until the demo is over: the same flag
shows the "Proposed from mail by a model" section on `/discovery`. Turn it off
afterwards. The rows stay until the step is deleted with #459, and go with their
mailbox source if it is deleted. A row whose candidate is rejected, merged or
deleted is archived, not deleted (owner decision; deletion is pending user
feedback): it leaves `/discovery` and keeps its deal key and name. To restore it:
`update discovery_model_proposals set archived_at = null where tenant_id = '<tenant id>' and deal_key = 'c:<candidate id>';`

Verify: the line is in the deployment record;
`select outcome, count(*) from discovery_model_proposals where tenant_id = '<tenant id>' group by outcome`
matches the first run's `deal`, `not deal` and `invalid` counts; `/ai-costs`
shows the spend as "Deal proposal (demo)"; and after item 6,
`aws ecs list-task-definitions --family-prefix conductia-discovery-classify-propose --status ACTIVE`
prints an empty list.

### Team inbox proposals: the flip (owner-gated, not built)

Proposed ([D118](../07-decisions/decision-log.md), number to confirm at merge; issue #173, G-01). The propose run above reads a person's own mailbox
only, and so does every run today: ADR-0026 residual 4 keeps a team inbox out of the step, and lifting it is the owner's
call ([ADR-0026, Owner question Q1](../07-decisions/ADR-0026-team-inbox.md#owner-question-q1-lift-residual-4-for-ignatiouss-team-inbox-before-oct-30-and-confirm-who-reads),
answered 2026-10-23: off for Oct 30, lift only if T1 = company names). The code is built and off, so there is nothing to do here
unless the owner later lifts it (A, or C). This section
is the flip, written down so it is a reviewed change and not an improvisation.

**Gates.** Each is in the deployment record before the flip PR merges:

1. The owner's answer to Q1, in writing: A, or C (A without the CCO reading proposals). C also needs its own reviewed
   migration and SQL test merged first: a proposal-specific reader rule with no CCO branch in `app_reads_proposal_source`
   (ADR-0026, Q1). Dropping a branch there alone changes nothing, because it admits the CCO through `app_reads_team_mailbox`.
2. Slices `[173 1/5]` to `[173 5/5]` merged to `develop`, and the audit-trail slice
   (`feat/173-g01-trail-team-proposal-audit`, migration `20261023110400`) merged too. **That slice is held until #711 to
   #716 are on `develop`**, and the flip PR is gated on it: without it the firm admin and CCO cannot see passes or
   approval changes in the team-inbox audit trail.
3. #684 (the allow-list approval and the tenant id), allow-list slice 3 with the D91 go.
4. G11: `npm run ai:zdr-probe` green with the production key, recorded.
5. The propose run's own preconditions above (the owner's go, Ignatious's written ZDR confirmation and approval for
   AI on their mail, a gateway plan that accepts the ZDR flag, the reviewed `MODEL_PROPOSAL_TENANT_IDS` change, the
   `discovery_model_proposals_demo` flag, the gateway key).
6. #346 merged (D75).
7. The team inbox is Ready and its members are added (the team inbox guide), and the Oct 27 read-only rehearsal has
   given the real unrouted count, so the owner knows the volume and the cost before sending anything.

**The flip is two reviewed changes in one PR, and neither works alone.**

1. A `{ tenantId, firmCompanyId }` entry in `TEAM_PROPOSAL_FIRMS` (`src/lib/discovery/propose/gate.ts`). The constant ships
   empty and has no environment override; `teamFirmList` is a tests-only option that no worker or script sets, and the
   step keeps only the firms the list names, whatever it is handed.
2. One migration row, numbered above `develop`'s newest at the time (`ls supabase/migrations | tail -1`, then
   `npm run check:migrations -- --base origin/develop`), guarded so a wrong tenant and firm pair inserts nothing:

   ```sql
   insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
   select c.tenant_id, c.id, 'team_proposals', '<the owner decision, an issue or a PR; 80 characters at most>'
   from companies c
   where c.id = '<firm company id>' and c.tenant_id = '<tenant id>';
   ```

   The migration reaches a hosted database only through the Migrate database Action, after the PR is approved and merged.
   The insert writes one `discovery.tenant_approval_changed` audit row by itself (service actor
   `discovery-tenant-approvals`). Then an image built at the commit that holds both (step 5), stage 2 again (step 6) and
   the gates its rebuild rule names.

**Revoke.** Two reviewed changes in the other direction, **the SQL row first**. The halves do not stop a running worker
equally:

1. **Revoke the row**, in a migration of its own, merged and applied first (the Migrate database Action, minutes after
   the merge). The row is revoked, never deleted; the trigger refuses delete and truncate, and a revoke changes
   `revoked_at` alone:

   ```sql
   update discovery_tenant_approvals set revoked_at = now()
   where tenant_id = '<tenant id>' and firm_company_id = '<firm company id>'
     and capability = 'team_proposals' and revoked_at is null;
   ```

   This stops a run already in progress. The writer refuses the next row it would save for that firm's inboxes, and the
   next renewal refuses too (once per page, and before any call or retry once less than two minutes of the lease
   remain), so the pass ends `revoked`. Every model call is followed by a save before the next call, so at most one
   message per inbox, with its retries, is sent after the revoke commits. A run that starts later reads the row at its start and does not hand the inbox over at all.
2. **Remove the TS entry**, in a second PR. A running worker does not see this: `runOnce` reads `TEAM_PROPOSAL_FIRMS`
   when the run starts and the step keeps that list for the whole run. It takes effect only for runs started from an
   image built after the change. On its own it would leave a running worker sending until the run ends, which is why
   the row goes first.

To approve again, a later migration clears `revoked_at` under a new `decision_ref`, and the TS entry is restored.
Mail already sent to the processor cannot be recalled; ZDR means it is not retained, and the `started` and `finished`
audit rows record which passes ran. Proposals already written under a pass stay readable to the same people (they do not need
a live approval); there is no archive step for them today.

**After a run** (counts only, no text):

```sql
select outcome, count(*) from discovery_team_proposal_passes where tenant_id = '<tenant id>' group by outcome;
select count(*) from discovery_team_proposal_passes where tenant_id = '<tenant id>' and closed_at is null;
select action, count(*) from audit_log
where tenant_id = '<tenant id>'
  and action in ('discovery.team_mailbox_proposal_started', 'discovery.team_mailbox_proposal_finished',
                 'discovery.tenant_approval_changed')
group by action;
```

A pass can stay open after its run ends, so a `started` can lack its `finished` for a while. The worker's closing call
is best effort: if it fails (the error is swallowed, so the sync itself does not fail) or the worker dies, the pass stays
open until its lease lapses, at most 30 minutes after its last renewal. The next propose run then closes it `unclosed`
before reading any source, whether or not the inbox may still be read, and writes its `finished` row. So every `started`
has a `finished` once a later run has started after the lease lapsed. To tell a pass in progress from one waiting to be
swept:

```sql
select run_id, renewed_at, lease_until, lease_until > now() as lease_live
from discovery_team_proposal_passes
where tenant_id = '<tenant id>' and closed_at is null;
```

`lease_live` true is a run in progress, or one whose close failed less than 30 minutes ago; false is a pass the next run
will close. `pass_in_progress` means another run held the inbox with a fresh lease; wait 30 minutes or for that run to
end. The summary line's `sources refused` above zero means a switch half, the inbox's allowlist or a busy
pass stopped a team inbox: read the pass outcome before changing anything.

**Rehearsing it on a local stack.** Both halves are needed: a local, uncommitted edit adding the dev tenant and firm
company to `TEAM_PROPOSAL_FIRMS`, and a `discovery_tenant_approvals` row inserted with `psql` as the database owner.
Neither is ever committed or applied to a hosted database. The shipped constant stays empty.

### Restore a dismissed model proposal

Proposed ([D119](../07-decisions/decision-log.md), number to confirm at merge; issue #173, G-02). It needs a
database that holds `[173 G-02 1/5]` (migrations `20261023120000` and `20261023120100`). It is not a numbered step
or a gate, and it starts nothing.

The owner of a mailbox can select **Dismiss** on a row of "Proposed from mail by a model" on `/discovery`. The
proposal rows of that deal the owner could see at that moment leave their list, and the card shows "N dismissed"
and, under it, "Dismissed. Restore reference" with a uuid: the dismissal's operation id, which carries no content.
A later proposal of the same deal shows again. Nothing is deleted: the dismissal is one row per mailbox source in
`discovery_model_proposal_dismissals`, all sharing that operation id and each listing the proposal rows it hides,
plus one `discovery.model_proposal_dismissed` audit row with ids and counts only. The product has no restore yet (a
self-serve restore is a follow-up), so an operator restores a dismissal when the owner asks.

Rules:

- **Only the owner asks, with the reference.** The person asking must own the mailbox the dismissal sits on. The
  function checks it and refuses otherwise. Ask for the restore reference the card showed. Record the request (who
  asked, when, and the reference) in the deployment record before running anything.
- **Ids only in a statement.** Never type an address, a deal name or a deal key into the SQL editor. `deal_key` is a
  slug of a deal name the model read in mail, and it is never logged. The queries below take and print ids, times
  and counts only; the deployment record keeps ids only.
- **Through the function only.** Never `delete` from or `update` the dismissals table by hand: a hand edit writes
  no audit row. The restore marks a row and never deletes it.

In the SQL editor (as `postgres`; of the API roles, only `service_role` may execute the function):

1. The dismissal the reference names, and its owner:

   ```sql
   select a.id as audit_id, a.ts, a.actor_id as owner_user_id, a.detail->>'keyKind' as key_kind,
          a.detail->>'rowCount' as row_count, a.detail->'dismissalIds' as dismissal_ids
   from audit_log a
   where a.tenant_id = '<tenant id>' and a.action = 'discovery.model_proposal_dismissed'
     and a.detail->>'operationId' = '<restore reference>';
   ```

   One row. `owner_user_id` must be the person asking: match it against the user id on the request's own record
   (the ticket or the signed-in session that sent it), never by looking an address up here. No row means the
   reference is wrong or from another tenant: ask the owner again.

2. Which of its dismissals are still live:

   ```sql
   select d.id, d.dismissed_at, d.content_source_id, cardinality(d.proposal_ids) as row_count
   from discovery_model_proposal_dismissals d
   where d.tenant_id = '<tenant id>' and d.operation_id = '<restore reference>' and d.restored_at is null
   order by d.id;
   ```

   Each dismissal hides only the rows it lists, so restoring these brings back exactly the rows that dismissal hid.
   If the owner dismissed the same deal more than once and wants all of it back, they give each reference, and you
   restore each.

3. Restore the ids step 2 listed. `p_requested_by` is the `owner_user_id` from step 1; `p_identity` is the operator
   who runs it, never a secret, and becomes the audit row's service identity:

   ```sql
   select discovery_restore_model_proposal_dismissals(
     p_tenant        => '<tenant id>',
     p_dismissal_ids => array['<dismissal id>', '<dismissal id>']::uuid[],
     p_requested_by  => '<owner user id>',
     p_identity      => '<operator>');
   ```

   It returns how many dismissals it restored, and writes one `discovery.model_proposal_dismissal_restored` audit
   row (`dismissalIds`, `operationIds`, `requestedBy`; a service actor under `<operator>`). `0` means every listed id
   was already restored: nothing changes and no audit row is written. `22023` changes nothing: an argument is
   missing or blank, or a listed id is not in the tenant or sits on a mailbox the requester does not own; check the
   ids and the requester. `55P03` means the worker held the tenant's discovery lock for more than 5 seconds: run it
   again.

Verify the restore you ran, by its ids and its requester:

```sql
select a.id as audit_id, a.ts, a.service_identity
from audit_log a
where a.tenant_id = '<tenant id>' and a.action = 'discovery.model_proposal_dismissal_restored'
  and a.detail->>'requestedBy' = '<owner user id>'
  and a.detail->'dismissalIds' @> to_jsonb(array['<dismissal id>', '<dismissal id>']::uuid[]);

select d.id, d.restored_at, d.restored_by_identity, d.restore_requested_by
from discovery_model_proposal_dismissals d
where d.tenant_id = '<tenant id>' and d.id = any (array['<dismissal id>', '<dismissal id>']::uuid[]);
```

The first returns one row under `<operator>`; the second shows every id restored by `<operator>` at the owner's
request. Then the owner reloads `/discovery`: the deal's rows show again, and "N dismissed" is one lower unless the
deal still has a hidden row from another dismissal. For a deal only the model named, the next propose run offers the
name to the model again for that mailbox. Record the request, the reference, the ids, the return value and the
`audit_id` from the first query in the deployment record. A restored row stays in the table with `restored_at`,
`restored_by_identity` and `restore_requested_by` set; if the owner wants the deal hidden again, they select
**Dismiss** again, which adds a new row. Dismissal rows go with their mailbox source on disconnect and at pilot end,
like the proposals, and with them when #459 lands.

## Milestone rules: the detect task and the per-firm switch (owner steps, not applied)

Proposed ([D120](../07-decisions/decision-log.md), number to confirm at merge; issue #173, gap G-07;
[ADR-0026](../07-decisions/ADR-0026-team-inbox.md), "Station suggestions on team mail (D120)"). It is
not a numbered step or a gate, and it starts no service. Nothing here has been applied, and nothing
can be yet: the `detect` entrypoint mode and the worker's `--rules` flag arrive with slice 3b, which
reads G-01's approval table (`20261023110100_discovery_tenant_approvals.sql`, on `develop`) and is
not merged yet. The detect mode reads stored
mail text inside the task, runs the `rules/v1` detector on it and writes dated milestone facts. It
sends nothing out of the process. Every line it prints is integers and fixed codes, never a sentence,
a span, a subject or an address. Record each line in the deployment record.

**Verification here is manual** (audit S16). Every "Verify" in this section is a command the owner runs
and reads, and the deployment record holds its output. No focused check covers the detect family yet:
`tests/infra/runbook-order.test.ts` and the module's plan checks name it only once the reviewed infra
change below adds it, and until then nothing in CI fails when a step here is skipped or its output is
wrong.

**Preconditions**, each in the deployment record before anything changes:

- The owner's answers, decided 2026-10-23 (ADR-0026, "D120 owner question Q1" and "Q2"): Q1 is A,
  the rule detector; Q2 approves `milestone_rules` for Ignatious once the rehearsal shows the
  expected phases. The flip migration and this ECS detect step stay owner steps.
- D120 slices 1a to 4 and G-01 slices 2 and 4 merged to `develop`. Proposed: D120 slice 5 too, so
  the firm admin and the CCO see each detection pass in the team-inbox audit trail.
- The measured precision: the negative corpus (no false match on 105 sentences, measured 2026-10-22)
  and the held-out set's counts line (measured 2026-10-22:
  `heldout files=3 sentences=343 tp=18 fp=1 fn=157 tn=168`), re-read at the commit the image is built
  from.
- The rehearsal on the loopback stack, with a local approval row inserted with `psql` there only.
- The Ignatious tenant id and firm company id (#684).
- An image built at a commit that holds slice 3b (step 5), then stage 2 again (step 6) and the gates
  its rebuild rule names.

### Register the detect task (a reviewed infra change, then an apply)

The module registers no `detect` family today. A reviewed change to `infra/discovery-worker/` adds
one in the shape of `estimate` (`ecs.tf`), with no command override ever:

- the fixed command `["detect", "--tenant", var.probe_tenant_id]`, which the entrypoint runs as the
  worker's `--rules` mode for that tenant only;
- `NEXT_PUBLIC_APP_ENV` and `NEXT_PUBLIC_SUPABASE_URL` as its environment and `SUPABASE_SECRET_KEY`
  as its only secret, **for Demo runs only** (audit S14). That `sb_secret_` key reads and writes every
  tenant's rows in the shared project, and ADR-0020 decision 5 makes the narrower database credential
  (decision 1) a Pilot gate. The two runs this section verifies with, the one before the flip and
  the one right after it, may use the key, each recorded as a Demo run. Any later run needs the
  narrower Pilot credential first: a reviewed change swaps the task's secret for it, scoped to what
  the detect mode reads and writes, and until that change is applied the owner neither schedules the
  task nor runs it again. The one exception is the drain after a revoke, which only stops rule events
  from counting: it may use the key, recorded as such. No gateway variable and no gateway key: the
  mode builds no model transport and calls no processor gate. No workload identity config either: it
  reads from the database, never from Gmail;
- its log stream prefix, `detect/worker/<task id>`, in the module's log group;
- the family in `locals.tf` and in deploy's run statement beside `probe`, `once` and `estimate`
  (`deploy_role.tf`). It carries the same secret as `estimate` and nothing more, so it adds no reach
  to `deploy` beyond what the [blast radius](#blast-radius-under-p1--a) already states;
- the family in `tests/infra/runbook-order.test.ts`, and this section's run command, in the same PR.

Proposed: a schedule is a later reviewed change, after the first verified runs. Until one exists,
the owner runs the task by hand after the flip, after a revoke, and after a classify pass whose mail
should be placed. Announce the window and apply as admin. The plan shows the new family, its entry in
deploy's statement and nothing else.

Verify: `aws ecs list-task-definitions --family-prefix conductia-discovery-detect --status ACTIVE`
lists one revision.

### Run it once before the flip

As `deploy`, run the new family exactly as the estimate task runs in "Switching later", P2 = B,
item 4, with the detect family in place of `conductia-discovery-estimate` and no command override,
then read its log stream as admin. With no approval row the task reads no mail: it loads the tenant's
`milestone_rules` approvals first (a read error counts as none), drains the recompute outbox (ids and
types, never text), prints `capability_not_approved` and its counts, and exits 0. Any other result,
or any line that is not integers and fixed codes, stops the switch: record it and go back to the
design owner. The exact counts line is fixed by slice 3b.

### The flip: one guarded migration row

Only a reviewed migration writes `discovery_tenant_approvals`. Insert, update, delete and truncate
are revoked from every API role, its trigger refuses a delete, and a row is revoked, never deleted.
Never paste these statements into the SQL editor. The migration is numbered above `develop`'s newest
at the time (`ls supabase/migrations | tail -1`, then
`npm run check:migrations -- --base origin/develop`), and it reaches the hosted database only
through the Migrate database Action, after the PR is approved and merged. The guard makes it a no-op
with no audit row on every other project and in CI, and for a wrong tenant and firm pair:

```sql
insert into discovery_tenant_approvals (tenant_id, firm_company_id, capability, decision_ref)
select c.tenant_id, c.id, 'milestone_rules', '<D120 and the owner decision; 80 characters at most>'
from companies c
where c.id = '<firm company id>' and c.tenant_id = '<tenant id>';
```

The insert writes one `discovery.tenant_approval_changed` audit row by itself (G-01's trigger). Then
run the detect task once more, as above. Its line now carries counts and no
`capability_not_approved`. The row covers only that firm's allowed mail: its seated bankers'
personal mailboxes, its registered sites and its verified team inboxes.

Verify, counts only, never text:

```sql
select count(*) from milestone_detections where tenant_id = '<tenant id>';
select action, count(*) from audit_log
where tenant_id = '<tenant id>'
  and action in ('discovery.milestone_detected', 'discovery.team_mailbox_milestones_detected',
                 'discovery.tenant_approval_changed')
group by action;
```

### The revoke: one guarded migration, no purge

The same rules as the flip. The revoke changes `revoked_at` alone and queues a recompute for every
candidate of the tenant with a live link to an item that holds a rule event. Proposed: the column
names follow slice 3b's planned schema (`milestone_events.detection_id`), and the revoke migration is
written against the schema then on `develop`:

```sql
update discovery_tenant_approvals set revoked_at = now()
where tenant_id = '<tenant id>' and firm_company_id = '<firm company id>'
  and capability = 'milestone_rules' and revoked_at is null;

insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
select distinct dc.tenant_id, dc.id, 'rerun'
from deal_candidates dc
join evidence_links el on el.candidate_id = dc.id and el.state <> 'rejected'
join milestone_events me on me.source_item_id = el.source_item_id and me.detection_id is not null
where dc.tenant_id = '<tenant id>'
  and exists (select 1 from discovery_tenant_approvals a
              where a.tenant_id = '<tenant id>' and a.firm_company_id = '<firm company id>'
                and a.capability = 'milestone_rules' and a.revoked_at is not null);
```

What takes effect when:

- **At once.** Rule events leave every timeline and evidence list, because the read RPC counts a
  rule event only through an approved firm.
- **At the next detect run.** A run in progress when the revoke commits stops writing: the writer
  re-checks the approval on every item and refuses (`capability_not_approved`). Run the task once
  after the migration applies. With no other firm of the tenant approved, it prints
  `capability_not_approved`, reads no mail and drains the queued requests, so every assessment drops
  the rule events.
- **Never purged.** Rule events stay stored and stop counting. Consent, tenant and orphan purges still
  remove them with their mail.
- **Stops counting, not hiding.** A revoke takes rule events out of every suggestion, timeline and
  evidence list, which read them through the current-events rule. It does not hide the stored rows:
  `milestone_events` is read under `app_can_see_item`, so anyone who can see the message can still
  read its rule events directly (types, dates and offsets), approved or not, revoked or not. That
  person already holds the message text. A stricter read path is a logged follow-up (audit round on
  #753).

To approve again, a later migration clears `revoked_at` under a new `decision_ref`, which G-01's
trigger requires.

Verify, before calling the revoke complete (audit S15): after that run,
`select count(*) from discovery_recompute_requests where tenant_id = '<tenant id>'` reads 0, and the
revoke's `discovery.tenant_approval_changed` row is in the audit log. A run reads the whole queue page
by page and answers every request it read (slice 2b, since the audit round; before it, one run read at
most 1,000 requests), but extraction and corrections may queue new requests meanwhile. So drain until
empty: while the count reads more than 0, run the task again and count again. Record each count. A
revoke is complete only after a run followed by a count of 0; a count that does not fall between two
runs stops the procedure: record it and go back to the design owner.
