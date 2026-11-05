#!/bin/bash
# Registers this host's runner with GitHub (ci-runner-register.service, every
# boot). Once registered (.runner exists) it does nothing: the runner service
# reconnects with its own credentials.
#
# The host never sees the PAT. It reads a registration token that the wake
# function refreshes in SSM every 45 minutes (valid 1 hour, good only for adding
# a runner to this repository). The token never reaches the log, argv or disk: no
# xtrace, and config.sh gets it through ACTIONS_RUNNER_INPUT_TOKEN.
#
# Env (from /etc/ci-runner.env): AWS_REGION REPO RUNNER_CLASS RUNNER_LABELS TOKEN_PARAMETER
set -euo pipefail
set +x

dir=/opt/actions-runner
log() { echo "ci-runner register: $*"; }

date +%s > /var/lib/ci-runner/last-activity
chown runner:runner /var/lib/ci-runner/last-activity

if [ -f "$dir/.runner" ]; then
  log "already registered"
  exit 0
fi

imds_token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
instance_id=$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" http://169.254.169.254/latest/meta-data/instance-id)
name="$instance_id-$RUNNER_CLASS"

# Right after an apply the wake function may not have written the token yet.
reg_token=""
for _ in $(seq 1 30); do
  if reg_token=$(/snap/bin/aws ssm get-parameter --region "$AWS_REGION" --name "$TOKEN_PARAMETER" \
    --with-decryption --query Parameter.Value --output text 2>/dev/null); then
    break
  fi
  reg_token=""
  sleep 10
done
if [ -z "$reg_token" ]; then
  log "no registration token in $TOKEN_PARAMETER after 5 minutes; not registered (idle-stop will stop this host)"
  exit 1
fi
reg_token=$(printf '%s' "$reg_token" | tr -d '\r\n')

cd "$dir"
ACTIONS_RUNNER_INPUT_TOKEN="$reg_token" sudo -u runner --preserve-env=ACTIONS_RUNNER_INPUT_TOKEN \
  ./config.sh --unattended --url "https://github.com/$REPO" --name "$name" \
  --labels "$RUNNER_LABELS" --work _work --replace
unset reg_token

# Runner environment: tool cache and the job hooks (after config.sh, which
# writes its own .env entries first).
sed -i '/^RUNNER_TOOL_CACHE=/d; /^ACTIONS_RUNNER_HOOK_JOB_/d' .env
{
  echo "RUNNER_TOOL_CACHE=/opt/hostedtoolcache"
  echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/ci-runner/job-started.sh"
  echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/ci-runner/job-completed.sh"
} >> .env
chown runner:runner .env

./svc.sh install runner
./svc.sh start
log "$name registered with labels $RUNNER_LABELS"
