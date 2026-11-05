#!/usr/bin/env bash
# Seed the #162 throwaway stack with a production-sized book: the seed users,
# the 12-deal mock book (65 steps per deal), the book MD's seats, then the
# project-rail backfill (mock-scale rows are created with phase_index null,
# which would render "This deal's rail is not set up yet").
#
#   scripts/perf/seed-rail-scale.sh
#
# Every script runs through with-local-stack.sh --write (env -i + the loopback
# preload, after confirming the running containers are the cdt162-rail stack's
# on its own ports). Each is called with `node --import tsx`, NOT `npm run …`: the npm
# scripts pass --env-file=.env.local, which would fill the hosted values
# straight back in.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUN=("$HERE/with-local-stack.sh" --write)
BOOK_MD="book-md.intelibank@dev.com"

cd "$ROOT"
"${RUN[@]}" node --import tsx scripts/seed-flags.ts
"${RUN[@]}" node --import tsx scripts/seed-users.ts
"${RUN[@]}" node --import tsx scripts/seed-mock-scale.ts
"${RUN[@]}" node --import tsx scripts/grant-mock-book.ts "$BOOK_MD"
"${RUN[@]}" node --import tsx scripts/backfill-project-rail.ts
"${RUN[@]}" node --import tsx scripts/perf/set-local-flags.ts \
  gate0_api_create=on platform_onboarding=on project_rail_model=on workbench_top_nav=off
