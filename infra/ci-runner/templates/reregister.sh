#!/bin/bash
# Run by hand in an SSM session (sudo /opt/ci-runner/reregister.sh) when GitHub
# has removed this runner (offline more than 14 days, or deleted in Settings):
# drops the local registration and registers again with the current token.
set -euo pipefail

cd /opt/actions-runner
./svc.sh stop || true
./svc.sh uninstall || true
rm -f .runner .credentials .credentials_rsaparams
systemctl restart ci-runner-register.service
systemctl --no-pager status ci-runner-register.service || true
