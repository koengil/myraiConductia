#!/usr/bin/env bash
# Decide whether a change touches the work-identity sign-in path (#316), for
# ci.yml's `changes` job. Writes run=true|false to $GITHUB_OUTPUT. An uncertain
# change range (a missing commit, no merge base) runs the journey.
#   env: EVENT (github.event_name), BASE, HEAD
set -euo pipefail

run=true
if git cat-file -e "${BASE}^{commit}" 2>/dev/null && git cat-file -e "${HEAD}^{commit}" 2>/dev/null; then
  if [ "$EVENT" = pull_request ]; then BASE=$(git merge-base "$BASE" "$HEAD") || BASE=''; fi
  if [ -n "$BASE" ] && git diff --quiet "$BASE" "$HEAD" -- \
      src/app/auth/work src/app/join src/app/two-factor src/middleware.ts \
      'src/lib/api/v1/http*.ts' src/lib/auth \
      'supabase/migrations/*work_identity*' supabase/config.toml \
      'e2e/journeys/work-identity-*' e2e/support/mockOidc.ts \
      tests/integration/work-identity-broker.test.ts scripts/set-firm-identity-provider.ts \
      .github/workflows/e2e-work-identity.yml scripts/ci/enable-work-identity-broker.sh \
      scripts/ci/work-identity-changed.sh; then
    run=false
  fi
fi
echo "run=$run" >> "$GITHUB_OUTPUT"
echo "e2e-work-identity run=$run"
