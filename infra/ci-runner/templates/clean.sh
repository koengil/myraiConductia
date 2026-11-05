#!/bin/bash
# Job hook (ACTIONS_RUNNER_HOOK_JOB_STARTED and _COMPLETED, via the symlinks
# job-started.sh and job-completed.sh). Runs as the runner user. Removes what a
# job leaves behind that would break the next one: containers, volumes (named
# ones too: Supabase's), networks, dev servers on the e2e ports and e2e temp
# dirs. Keeps images, the npm cache, ~/.cache/ms-playwright and the tool cache.
set -uo pipefail

event=$(basename "$0" .sh)

# The runner calls hooks with `bash -e`, so every step is non-fatal: fuser, for
# one, exits 1 when nothing listens, and a failing hook fails the job.
docker ps -aq | xargs -r docker rm -f >/dev/null 2>&1 || true
docker volume prune -af >/dev/null 2>&1 || true
docker network prune -f >/dev/null 2>&1 || true
sudo -n fuser -k -n tcp 3000 4310 4311 >/dev/null 2>&1 || true
sudo -n rm -rf /tmp/e2e-* 2>/dev/null || true

date +%s > /var/lib/ci-runner/last-activity
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $event ${GITHUB_REPOSITORY:-} run=${GITHUB_RUN_ID:-} job=${GITHUB_JOB:-}" >> /var/log/ci-runner-hooks.log
exit 0
