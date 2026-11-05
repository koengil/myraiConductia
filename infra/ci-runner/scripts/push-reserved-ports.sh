#!/usr/bin/env bash
# Reserve the job ports from ephemeral allocation on every RUNNING runner host.
# user_data is ignored after creation, so hosts created before the reservation
# lack /etc/sysctl.d/90-ci-runner-ports.conf; keep the list in step with
# templates/cloud-init.yaml.tftpl. A stopped host is skipped: start it first,
# or rerun after its next wake.
# Usage (from infra/ci-runner): AWS_PROFILE=conductia-ci scripts/push-reserved-ports.sh
set -euo pipefail
region=${AWS_REGION:-us-east-1}
want=3000,4310-4311,54320-54329
ids=$(aws ec2 describe-instances --region "$region" \
  --filters Name=tag:Component,Values=ci-runner Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[ -n "$ids" ] || { echo "no running hosts"; exit 0; }
# shellcheck disable=SC2086 # ids is a space-separated list
cid=$(aws ssm send-command --region "$region" --instance-ids $ids --document-name AWS-RunShellScript \
  --parameters "commands=[\"echo 'net.ipv4.ip_local_reserved_ports = $want' > /etc/sysctl.d/90-ci-runner-ports.conf && sysctl --system >/dev/null && cat /proc/sys/net/ipv4/ip_local_reserved_ports\"]" \
  --query Command.CommandId --output text)
sleep 5
for id in $ids; do
  got=$(aws ssm get-command-invocation --region "$region" --command-id "$cid" --instance-id "$id" --query StandardOutputContent --output text | tr -d '[:space:]')
  [ "$got" = "$want" ] && echo "$id: reserved" || echo "$id: MISMATCH or pending (got ${got:-nothing})"
done
