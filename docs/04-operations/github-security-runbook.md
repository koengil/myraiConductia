# GitHub security runbook (owner steps, both repos)

What the owner switches on in GitHub, in what order, and how each switch is verified, for the supply-chain controls of issue #473 (SOC 2 Type I, control CC7.1) on `Conductia/Conductia` and `Conductia/conductia-agents-backend`. Status: Proposed. The decisions behind it are D110 (number to confirm at merge) in `docs/07-decisions/decision-log.md`; the control row is "Vulnerability management (CC7.1)" in [`soc2-control-register.md`](../08-security/soc2-control-register.md).

No GitHub setting is applied by an agent or a CI job, and nothing here is applied from the PRs that carry the code. This page lists the toggles; the owner flips them.

The conventions follow [`m365-sso-runbook.md`](./m365-sso-runbook.md) and [`csp-runbook.md`](./csp-runbook.md):
- A step marked "(human step)" is done by the owner or the triage owner in a browser or a shell, never by an agent or a CI job.
- `<placeholders>` are values you fill in. No token, key or secret value is written in this page, and none is pasted anywhere except the credential issuer's own console when you rotate it. `gh` uses your own login.
- Every step ends with a `Verify:` line, and a REST (`gh api`) equivalent sits beside the UI path wherever one exists.
- A step marked **STOP** interrupts the normal cadence. It names its check, where to look, what good looks like, and the remedy. If the remedy does not clear it by its deadline, escalate to the owner and record the miss in the evidence record.

Placeholders used throughout:

| Placeholder | Meaning |
|---|---|
| `<org>` | The GitHub organization, `Conductia` |
| `<repo>` | The repository the command runs on. Run each repo step once for `Conductia` and once for `conductia-agents-backend`, unless the step says one repo |
| `<triage owner>` | The one engineer, or the weekly rota, who triages security alerts (step 4) |
| `<develop ruleset id>` | The id of the `develop` ruleset on `Conductia/Conductia` (`23657662` today) |
| `<ruleset id>` | The id of a ruleset on `conductia-agents-backend` (`main` is `21065246`, `prod` is `22299380`) |
| `<alert number>` | A Dependabot alert number, from the alerts list |
| `<GHSA id>`, `<package>` | The advisory id and the package of an alert |
| `<enablement date>` | The date you turned Dependabot alerts on for the repo (step 2) |
| `<date>` | The date you did a step |
| `<issue>` | The number of a tracking issue |

## What is in place, and what is not

The code half of #473 is three PRs on `Conductia/Conductia`. Steps 5 and 7 assume they are merged.

| Control | Where | State |
|---|---|---|
| Dependabot version updates | `.github/dependabot.yml`: npm on `/` and `/evals/deal-discovery`, and github-actions. Target branch `develop`, weekly on Monday at 05:00 UTC, a 7-day cooldown (14 days for npm majors), minor and patch grouped, majors one by one. The `ai-review` workflow skips PRs from `dependabot[bot]` | Reads from `main`: it takes effect at the next promotion (step 7) |
| Secret scan (required) | The `secrets` job, check name `Secret scan`, in `.github/workflows/ci.yml`. gitleaks 8.30.1 (linux x64), downloaded each run into a fresh temp dir and checked against a sha256 pinned in the workflow. A pull request is scanned with the base commit's `.gitleaks.toml` and `.gitleaksignore`, every scan ignores inline `gitleaks:allow` comments, and each allowlist entry matches one reviewed value in a named file. A self-test runs on every event: a seeded canary behind a `gitleaks:allow` marker and a new credential in every allowlisted path must all be detected. It scans the commit range and the merge tree, with `--redact` | In `REQUIRED_CHECKS`, which only the "Promote develop to staging" Action enforces: `staging` has no ruleset and `main`'s blocks only deletion, force pushes and non-linear history, so a direct push to either skips it (CC8.1). **It does not block a merge into `develop` until step 5 is done**: until then a red `Secret scan` on a PR is a signal, not a gate |
| Static analysis (advisory) | The `sast` job, check name `Static analysis`. Semgrep CE 1.182.0 installed from a hash lock (`.github/semgrep/requirements.txt`), rulesets `p/javascript`, `p/typescript`, `p/react`, `p/nodejs` and `p/owasp-top-ten`, no login, `--metrics=off`. On a PR the check reports red for new ERROR findings against its base (`HEAD^1`) and never blocks a merge. A `develop` push runs a full scan, keeps a JSON artifact for 90 days, and reports red only when the scanner itself fails, never for a finding | Advisory, not in any ruleset. The baseline is 4 ERROR findings (to be confirmed: a local scan of `develop` at `953e0692` on 2026-10-21; the first `develop` run's artifact confirms or corrects it), tracked in the Semgrep baseline tracking issue (to be filed) |
| `SECURITY.md` | Not created | Waits on a monitored security contact. It never merges with a placeholder |
| `conductia-agents-backend` files | `dependabot.yml`, a separate `secret-scan.yml` with no path filter, and an advisory `sast` job | Prepared as a patch, not pushed. The agents-backend owner decides. Until step 5b is done there, its check is advisory |

Semgrep terms: the registry rulesets run anonymously, and the [Semgrep Rules License v1.0](https://semgrep.dev/legal/rules-license) allows internal business use, which is scanning our own code in our own CI with internal results. `p/default` is not used: it carries third-party AGPL rules.

**Residual risk (Proposed, owner to close or accept).** A pull request's `Secret scan` runs the workflow from the PR's own merge commit (`pull_request`), so a PR that edits `.github/workflows/ci.yml` can make the check report green without scanning. The base-commit config, the ignored `gitleaks:allow` comments and the exact-value allowlists close the scanner-side routes. This one closes only when code-owner review is required on the workflow and scanner paths with a narrow owner list (step 12). Until then, the reviewer of any PR that touches `.github/workflows/`, `.gitleaks.toml` or `.gitleaksignore` treats its green `Secret scan` as unproven.

**Semgrep lock updates.** Dependabot does not update `.github/semgrep/requirements.txt`: `dependabot.yml` covers npm and GitHub Actions only, and the lock is a hash lock generated by uv. To move Semgrep, change the pin in `.github/semgrep/requirements.in`, regenerate the lock with the `uv pip compile` command in the lock's header (Python 3.12, `x86_64-manylinux_2_28`, `--generate-hashes`), put the header back, run `node --test scripts/ci/gates.test.mjs`, and open a PR. Proposed cadence: monthly, and inside the SLA when an advisory affects the pinned version. The triage owner (step 4) owns it.

## Decisions this runbook carries (all Proposed, owner to confirm)

| Decision | Value |
|---|---|
| Cost (Q1) | Buy nothing now. No GitHub Secret Protection or Code Security. Both products are paid on private repos, and Vanta ingests Dependabot alerts only |
| Exception X1 | Push protection is deferred. A credential can reach a GitHub branch before CI runs. Compensating controls: the required `Secret scan`, the free secret risk assessment (step 1) and the rotation rule (step 9). Exit: buy Secret Protection and turn push protection on, or record formal risk acceptance in the CC7.1 row. Review by the first of: the assessment result, Vanta onboarding (#467), 2026-12-15 |
| Exception X2 | Dependabot security updates stay off on `Conductia`: they always target `main`, which only moves by fast-forward. `Conductia` gets alerts plus a defined remediation path to `develop` (step 4). They stay on for `conductia-agents-backend` |
| Remediation SLAs (Q2) | Calendar days from first detection: critical 7, high 30, medium 90, low 180. The clock runs on `main`, because alerts track the default branch |

## 1. Secret risk assessment (human step)

Free for Team organizations, a one-off scan of the history of every repo in the org for secrets. It is the baseline for exception X1 and the input to the purchase decision in step 6. Needs an organization owner.

- **UI.** Organization settings, Code security (GitHub moves this label; search the GitHub docs for "secret risk assessment"), then run the report.
- **REST.** None known. Record the result from the UI.
- Record the report date and, for each of the two repos, the finding count. Never paste a finding's value anywhere, including the evidence record.
- A count above zero for either repo means a credential has been on GitHub. Go to step 9 for each finding (rotate first), and weigh it in step 6.

Verify: the report date and a finding count for each repo are in the evidence record, and every finding has a rotation issue linked or a note that it is a test value.

## 2. Dependency graph and Dependabot alerts (human step)

Free on Team, and Vanta's only GitHub vulnerability feed. Turn them on **per repo**. Do not attach the organization's "GitHub recommended" security configuration: it enables paid features and bills on attach.

- **UI.** Repo settings, Advanced Security: Dependency graph, Enable; Dependabot alerts, Enable.
- **REST.** `PUT` enables the alerts and the dependency graph together.

  ```bash
  gh api -X PUT repos/<org>/<repo>/vulnerability-alerts
  ```

Enabling alerts creates alerts for vulnerable dependencies that already exist, and GitHub does not notify for every one of them. Do step 2b the same day, so the backlog is not untriaged.

Verify: the check below prints `204` for both repos. `404` means alerts are off.

```bash
gh api -i repos/<org>/<repo>/vulnerability-alerts | head -n 1
```

### 2b. Initial alert inventory (human step, the triage owner)

Done by the triage owner (step 4) on the enablement date.

1. Count the open alerts by severity, per repo, and list them:

   ```bash
   gh api "repos/<org>/<repo>/dependabot/alerts?state=open&per_page=100" --paginate \
     --jq '.[].security_advisory.severity' | sort | uniq -c

   gh api "repos/<org>/<repo>/dependabot/alerts?state=open&per_page=100" --paginate \
     --jq '.[] | [.number, .security_advisory.severity, .security_advisory.ghsa_id, .dependency.package.name, .dependency.scope] | @tsv'
   ```

2. Start each alert's SLA clock on `<enablement date>`. The due date is that date plus 7 days for critical, 30 for high, 90 for medium and 180 for low (Proposed values).
3. For every critical or high alert, open an issue titled `security: <GHSA id> <package>` with the labels `security` and `compliance: soc2` (step 4 creates `security`). The body holds the alert link, the severity, the first-detected date and the due date.
4. On `Conductia`, `main` is behind `develop` by everything not yet promoted, and alerts track `main`. For each alert whose package is already fixed on `develop`, mark its issue "fixed on develop, pending promotion" with the planned promotion date. To check the version on `develop`:

   ```bash
   git fetch origin develop
   git show origin/develop:package-lock.json | grep -A 2 '"node_modules/<package>"'
   ```

5. Paste the count table and the issue links into the evidence record.

Verify: counts by severity are recorded for each repo, every critical and high alert has an issue with a due date, and every alert fixed on `develop` is marked pending promotion.

## 3. Security updates, `conductia-agents-backend` only (human step)

Dependabot security updates open a PR for an alert. They always target the repo's default branch. On `conductia-agents-backend` that is `main`, which is also its integration branch, so the PRs land where work happens: keep them on. On `Conductia` the default branch is `main`, which accepts fast-forwards only and trails `develop`, so a security PR would patch a stale lockfile on a branch that refuses it: keep them **off** (exception X2). Alerts plus the remediation path in step 4 replace them there.

- **UI.** Repo settings, Advanced Security, Dependabot security updates.
- **REST.** `GET` returns `{enabled, paused}`; `PUT` enables, `DELETE` disables.

  ```bash
  gh api repos/<org>/<repo>/automated-security-fixes
  ```

Verify: `conductia-agents-backend` returns `"enabled":true`, and `Conductia` returns `"enabled":false`.

## 4. Triage owner and the `security` label (human step)

Name one engineer, or a weekly rota, as `<triage owner>`. The SOC 2 program lists the engineering control owner as "To confirm", so this is the owner's call. Record the name and `<date>` in the evidence record.

The triage owner:
- watches the security alerts of both repos (repo Watch, Custom, Security alerts);
- opens an issue for every critical or high alert within 1 business day, and for medium and low at the Monday triage, titled `security: <GHSA id> <package>` with the labels `security` and `compliance: soc2`;
- fixes through a PR to `develop` on `Conductia`, titled `fix(deps): bump <package> to <version> (<GHSA id>)` with `Refs #<issue>`, by `npm install <package>@<version>`, `npm update`, or an `overrides` entry in `package.json`. It does not wait for the weekly Dependabot version PR: its 7-day cooldown can use up a critical's whole window;
- promotes: critical by step 8, high, medium and low in the next scheduled promotion inside the SLA;
- closes the issue with the promotion run link as evidence, after the alert closes itself when `main` no longer resolves the vulnerable version;
- for an alert with no fix available, dismisses it with a reason and a compensating control recorded on the issue. A critical or high dismissal needs the owner's approval.

Create the label on each repo. `--force` makes the command safe to repeat. The `compliance: soc2` label exists on `Conductia`; create it the same way on `conductia-agents-backend` if it is missing.

```bash
gh label create security --repo <org>/<repo> --color B60205 --description "Security finding or remediation" --force
```

Verify: the triage owner is named in the evidence record, and `gh label list --repo <org>/<repo> --search security` shows `security` on both repos.

## 5. Add "Secret scan" to the Conductia `develop` ruleset (human step)

Only after the `Secret scan` PR is merged and the check has run green at least once on `develop`, so GitHub offers the name. `REQUIRED_CHECKS` already makes the "Promote develop to staging" Action require it; a direct push to `staging` or `main` does not run that Action (CC8.1). **Until this step is done, `Secret scan` does not block a merge into `develop`**: a PR can still merge with the check red. After it, org admins can still bypass it: the `develop` ruleset lists `OrganizationAdmin` with bypass mode `always`, as the `main` ruleset does. The bypass log is the evidence (CC8.1).

- **UI.** `Conductia/Conductia` settings, Rules, Rulesets, `develop`, "Require status checks to pass", Add checks, `Secret scan`. Keep the four existing checks, keep the setting non-strict as it is, and do not add `Static analysis`: it is advisory until its baseline issue has no open ERROR findings and two weeks of PR runs pass without a false-positive suppression.
- **REST (read-only check).** Edit the ruleset in the UI; the update call needs the whole rule set in its body.

  ```bash
  gh api repos/<org>/<repo>/rulesets/<develop ruleset id> \
    --jq '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'
  ```

Verify: the REST call lists five names, the original four and `Secret scan`, and a test PR with a seeded canary shows `Secret scan` as blocking in its merge box.

### 5b. Add it to the agents-backend `main` and `prod` rulesets (human step)

Only after the agents-backend owner has merged its `secret-scan.yml`, which has no path filter so it reports on every PR, and the check has run green once. Today neither ruleset has any required status check, so a failed scan there can merge, and a merge to `main` deploys. Confirm the job's check name reads `Secret scan` before you add it.

- **UI.** `conductia-agents-backend` settings, Rules, Rulesets, `main` and then `prod`, "Require status checks to pass", Add checks, `Secret scan`.
- **REST (read-only check).** Run it once per ruleset id.

  ```bash
  gh api repos/<org>/<repo>/rulesets/<ruleset id> \
    --jq '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'
  ```

Until this step is done, describe the agents-backend check as advisory, never as required.

Verify: both rulesets list `Secret scan`.

## 6. Secret Protection decision (human step, optional)

Decided from the step 1 result. No paid toggle is assumed: under Q1 nothing is bought now. GitHub Secret Protection is the only way to get push protection, and it costs about $19 per active committer per month, which is roughly $114 to $133 a month for the committers in the last 90 days.

- **The assessment found a secret ever pushed to either repo:** the pre-merge gap is real, and buying is justified.
- **It found none:** keep $0, keep exception X1 open, and review it by the first of: the assessment result, Vanta onboarding (#467), 2026-12-15.

To buy, per repo (this starts metered billing, so only after the owner approves the cost):

- **UI.** Repo settings, Advanced Security, Secret Protection, Enable; then Push protection, Enable.
- **REST.**

  ```bash
  gh api -X PATCH repos/<org>/<repo> \
    -f 'security_and_analysis[secret_scanning][status]=enabled' \
    -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
  ```

X1 is recorded either way: closed (bought, push protection on both repos), or open with the review date, or accepted in writing in the CC7.1 row of the control register with a date for review.

Verify: the decision, its date and the X1 status are in the evidence record, and if you bought, the call below reports both settings `enabled` on both repos.

```bash
gh api repos/<org>/<repo> --jq '.security_and_analysis'
```

## 7. The promotion that activates `dependabot.yml` (human step)

Dependabot reads `.github/dependabot.yml` from the default branch. Merging the file to `develop` changes nothing: it takes effect at the next promotion develop to staging to main (Actions, "Promote develop to staging", then "Promote staging to main", per `docs/03-engineering/delivery-model.md`).

That release also changes files under `.github/workflows/` (`ci.yml`, `ai-review.yml`). If the fast-forward is rejected with `refusing to allow a GitHub App to create or update workflow`, follow the manual fast-forward and "Re-run failed jobs" path in the delivery model, not a new run.

After the promotion:
- The first version-update PRs arrive on the next Monday at 05:00 UTC, targeting `develop`, with the prefixes `chore(deps)`, `chore(deps-dev)` and `ci(deps)`. Minor and patch updates arrive grouped; each major arrives alone after its cooldown.
- Dependabot PRs run the full CI on the persistent fleet, including `npm ci` and package install scripts. That is third-party code execution, like any PR that adds a dependency, and it is part of the persistent-runner risk of ADR-0027. The cooldown reduces it and does not remove it. Review the diff before approving.

Verify: the file is on `main` (the call below prints its name), Insights, Dependency graph, Dependabot lists the npm entries for `/` and `/evals/deal-discovery` and the github-actions entry with a recent check time and no error, and the first Monday's PRs target `develop`.

```bash
gh api "repos/<org>/<repo>/contents/.github/dependabot.yml?ref=main" --jq .name
```

## 8. Critical alert: out-of-cycle promotion (STOP)

A critical alert has a 7-day window (Proposed, Q2). The clock runs on `main`, because alerts track the default branch: the window ends when the fix reaches production, not when it merges to `develop`. A weekly promotion cadence can miss it, so a critical alert stops the normal cadence.

- **Check.** A new critical alert, from the repo's security notifications or:

  ```bash
  gh api "repos/<org>/<repo>/dependabot/alerts?state=open&severity=critical" --jq '.[] | [.number, .created_at, .security_advisory.ghsa_id]'
  ```

- **Where to act.**
  1. The issue from step 4, with the due date (first detection plus 7 days).
  2. `Conductia`: a `fix(deps)` PR to `develop`. When its post-merge run on `develop` is green, run **Promote develop to staging**, then **Promote staging to main**, the same day and outside the schedule. This ships everything on `develop`, so unfinished work must be behind its flag.
  3. `conductia-agents-backend`: the Dependabot security PR targets `main`. Review it and merge it inside the window. A merge to `main` deploys.
- **Good.** The alert reads `fixed` on `main` and the issue is closed with the promotion run link:

  ```bash
  gh api repos/<org>/<repo>/dependabot/alerts/<alert number> --jq '{state, created_at, fixed_at}'
  ```

- **Remedy.** A promotion rejected by a red check: fix forward on `develop` and promote again; do not bypass a ruleset for a dependency bump. No fix is available: dismiss the alert with a reason and a compensating control on the issue, with the owner's approval.

If the remedy does not clear it by its deadline, escalate to the owner and record the miss in the evidence record.

Verify: for each critical alert, `created_at`, `fixed_at` and the issue with the run link are in the evidence record, and `fixed_at` is within 7 days of `created_at`.

## 9. Secret-scan finding: rotate first (STOP)

A `Secret scan` finding means the credential is already on GitHub, even if a later commit removed it. GitHub keeps PR refs, so rewriting history is not remediation. Rotation is.

- **Check.** The `Secret scan` check is red on a PR or a `develop` push. The job log names the rule and the file, with the value redacted. Do not re-run the scan without redaction.
- **Where.** The job log, under "Scan the commit range" or "Scan the merge tree".
- **Remedy, in this order.**
  1. **Rotate it** at the issuer, before anything else. Record the issuer, the date and the rotation issue number. Never write the value.
  2. **Remove it** from the tree.
  3. **Rewrite** the branch to drop the commit, or rebuild the PR on a fresh branch, so the range scan is clean.
  4. Never add a PR-branch finding to `.gitleaksignore`. Git-mode fingerprints include the commit SHA and break on rebase or squash, and on a PR the ignore file comes from the base branch anyway.
  5. `.gitleaksignore` is reserved for a finding that is already on `develop` history or in the tree and has been **rotated**. Use the dir-mode fingerprint (`file:rule:line`) for a tree finding, and the git-mode one (`commit:file:rule:line`) only for a commit on `develop`, whose squash SHA is stable. Each entry carries a comment with its rotation issue. It goes in through step 10.
  6. A reviewed test fixture that is not a credential is not a finding to rotate: handle it by step 10.
- **Good.** The check is green on the rebuilt branch, and the rotation issue is closed.
- **Known blind spot.** The range scan reads `git log -p`, which shows no diff for a merge commit. A secret introduced in a conflict resolution is caught only by the merge-tree scan, which is the content that squash-merges into `develop`.

If the remedy does not clear it by its deadline, escalate to the owner and record the miss in the evidence record.

Verify: the rotation (issuer, date, issue number, no value) is in the evidence record, and the `Secret scan` run on the rebuilt branch is green.

## 10. Allowlist change: its own PR first (human step)

A pull request is scanned with the **base branch's** `.gitleaks.toml` and `.gitleaksignore`, every scan ignores inline `gitleaks:allow` comments, and each allowlist entry matches one exact value, so a PR cannot allowlist its own secret through the scanner. An allowlist entry takes effect only after it merges. One route stays open until step 12: a PR that edits the workflow itself (Residual risk, above).

1. Open a small PR that changes only `.gitleaks.toml` or `.gitleaksignore`. It is green, because there is nothing to find yet. Both files are code-owned and fenced for human review.
2. Allowlist one reviewed **value**: an `[[allowlists]]` entry with `condition = "AND"`, the file in `paths` (written `'''(^|/)<path>$'''`), the rule in `targetRules` and the exact value as an anchored regex in `regexes`. A path-only or rule-only entry would hide every new credential in that file; the self-test seeds a new credential into every allowlisted path, so a widened entry turns the check red. Prefer this to a fingerprint, which breaks when a line moves. Never allowlist a real credential: rotate it (step 9).
3. After it merges, open the fixture PR.

Verify: `git show origin/develop:.gitleaks.toml` holds the entry, and the fixture PR's `Secret scan` is green with its self-test step passing (the canaries and every allowlisted path detected, redacted).

## 11. Fork-PR workflow settings for private repos (human step)

Dependabot runs are treated as if they were opened from a fork: a read-only token and no Actions secrets. Before anything is claimed about outside contributions, record what each repo allows.

- **UI.** Repo settings, Actions, General: the fork pull request workflow options for private repositories ("Run workflows from fork pull requests" and its sub-options), and "Workflow permissions".
- **REST.** If the second call returns `404`, read the same fields from the UI.

  ```bash
  gh api repos/<org>/<repo>/actions/permissions/workflow
  gh api repos/<org>/<repo>/actions/permissions/fork-pr-workflows-private-repos
  gh api repos/<org>/<repo>/actions/permissions --jq .sha_pinning_required
  ```

The third call is a record only. Pinning every action to a SHA is a follow-up issue outside #473.

Read on 2026-10-22, identical on both repos: fork PR workflows off (`run_workflows_from_fork_pull_requests: false`, so no write tokens and no secrets or variables reach a fork's run), `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`, `allowed_actions: all` and `sha_pinning_required: false`. Re-read them when you do this step; the evidence record takes the values on that date.

Verify: the values for both repos are in the evidence record.

## 12. CODEOWNERS owner list and required code-owner review (human step)

The scanner PRs add these paths to `.github/CODEOWNERS`, each with the full current owner list: `/.gitleaks.toml`, `/.gitleaksignore`, `/.github/workflows/`, `/.github/dependabot.yml`, and (Proposed, PR 1c) `/.github/semgrep/`. The same paths are in `.github/ai-review/fence.json`, so a human reviews them.

Today this is a **review request, not enforcement**. The `develop` ruleset does not require code-owner review (`require_code_owner_review` is `false` on 2026-10-22), so a PR can edit `ci.yml` and report a green `Secret scan` (Residual risk, above). GitHub Team lists code owners for private repos, and the ruleset already exposes the parameter, so this is a setting, not a plan limit. Only the two owner actions together close it (Proposed):

1. Name a narrow owner list for `/.github/` as a whole, plus `/.gitleaks.toml` and `/.gitleaksignore`. At minimum it covers `/.github/CODEOWNERS`, `/.github/workflows/`, `/.github/semgrep/` and `/.github/ai-review/`: while `/.github/CODEOWNERS` keeps the broad list, any one of those approvers can approve a PR that widens the narrow lines, and the next PR edits `ci.yml` under the widened list. `.github/semgrep/` is what CI runs, and `.github/ai-review/fence.json` decides what a human must review. A change is a PR to `.github/CODEOWNERS` that keeps `tests/ai-review/codeowners.test.ts` green. The full current list does not close the residual. It names six of the eight people with write access, so any of them can approve a `ci.yml` change exactly as the one required approval allows today. Confirming the full list keeps the residual open in the CC7.1 row.
2. Turn on "Require review from Code Owners" in the `develop` ruleset: `Conductia/Conductia` settings, Rules, Rulesets, `develop`, "Require a pull request before merging". If the UI does not offer it, record that in the evidence record: the residual stays open and stays in the CC7.1 row.

Verify: the owner list is recorded, the first call prints the scanner lines with that list, and the second prints `true` (or the evidence record says the UI does not offer it).

```bash
gh api "repos/<org>/<repo>/contents/.github/CODEOWNERS?ref=develop" --jq .content | base64 -d | grep -n 'CODEOWNERS\|gitleaks\|dependabot\|workflows\|semgrep\|ai-review'
gh api repos/<org>/<repo>/rulesets/<develop ruleset id> \
  --jq '.rules[] | select(.type == "pull_request") | .parameters.require_code_owner_review'
```

## Not covered here

`conductia-site` and its public `security.txt`; pinning actions to SHAs; Dependabot `docker` and `terraform` ecosystems; changing the default branch to `develop`; entering the SLA values in Vanta (after #467); `SECURITY.md`, which waits on a monitored contact.

## Evidence record

Copy into a comment on #473 or a file the owner names. No secret values, no finding values, no tokens.

| Field | Value |
|---|---|
| Date and operator | |
| Step 1: secret risk assessment date, finding count per repo | |
| Step 2: Dependabot alerts on (`204`), per repo, and `<enablement date>` | |
| Step 2b: open alerts by severity, per repo | |
| Step 2b: issue links for critical and high alerts, with due dates | |
| Step 2b: alerts fixed on `develop`, pending promotion, and the planned promotion date | |
| Step 3: security updates, `conductia-agents-backend` true, `Conductia` false | |
| Step 4: triage owner, date, `security` label on both repos | |
| Step 5: `develop` ruleset lists `Secret scan` | pass / fail |
| Step 5b: agents-backend `main` and `prod` list `Secret scan`, or "waiting on the agents-backend owner" | |
| Step 6: Secret Protection decision, date, X1 status and review date | |
| Step 7: promotion run link, `dependabot.yml` on `main`, first Monday's PRs target `develop` | |
| Step 8: each critical alert, `created_at`, `fixed_at`, issue and run link, or "none" | |
| Step 9: each rotation: issuer, date, issue number, or "none" | |
| Step 10: each allowlist PR link, or "none" | |
| Step 11: fork-PR and workflow-permission values, per repo | 2026-10-22, both repos: fork PR workflows off, workflow token read-only, no PR approval by Actions, all actions allowed, SHA pinning not required |
| Step 12: CODEOWNERS owner list for the scanner paths; code-owner review required on `develop` (or "not offered in the UI") | |
| Exceptions X1 and X2: owner confirmation and date | |
