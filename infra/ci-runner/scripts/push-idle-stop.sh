#!/usr/bin/env bash
# Install the current idle-stop.sh on every RUNNING runner host, per class.
# user_data is ignored after creation, so hosts keep the script they booted
# with; run this after a change to templates/idle-stop.sh.tftpl. A stopped
# host is skipped: start it first, or rerun after its next wake.
# Usage (from infra/ci-runner, after init): AWS_PROFILE=conductia-ci scripts/push-idle-stop.sh
set -euo pipefail
cd "$(dirname "$0")/.."
region=${AWS_REGION:-us-east-1}
scripts=$(tofu output -json idle_stop_script_b64)
for class in $(jq -r 'keys[]' <<<"$scripts"); do
  b64=$(jq -r --arg c "$class" '.[$c]' <<<"$scripts")
  ids=$(aws ec2 describe-instances --region "$region" \
    --filters Name=tag:Component,Values=ci-runner "Name=tag:RunnerClass,Values=$class" Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  [ -n "$ids" ] || { echo "$class: no running hosts"; continue; }
  # shellcheck disable=SC2086 # ids is a space-separated list
  cid=$(aws ssm send-command --region "$region" --instance-ids $ids --document-name AWS-RunShellScript \
    --parameters "commands=[\"echo $b64 | base64 -d > /opt/ci-runner/idle-stop.sh.new && chmod 0755 /opt/ci-runner/idle-stop.sh.new && mv /opt/ci-runner/idle-stop.sh.new /opt/ci-runner/idle-stop.sh && sha256sum /opt/ci-runner/idle-stop.sh\"]" \
    --query Command.CommandId --output text)
  want=$(base64 -d <<<"$b64" | sha256sum | cut -d' ' -f1)
  sleep 5
  for id in $ids; do
    got=$(aws ssm get-command-invocation --region "$region" --command-id "$cid" --instance-id "$id" --query StandardOutputContent --output text | cut -d' ' -f1)
    [ "$got" = "$want" ] && echo "$class $id: updated" || echo "$class $id: MISMATCH or pending (got ${got:-nothing})"
  done
done
