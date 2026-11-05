#!/usr/bin/env bash
set -euo pipefail

# Confirms the DIRECT Postgres connection — the same path TablePlus uses — which
# is separate from the REST/API path that `npm run check:db` tests.
#
# First add DATABASE_URL to .env.local. Copy it from Supabase:
#   Settings -> Database -> Connection string -> Session pooler (IPv4).
# Then run: npm run check:pg

if [ ! -f .env.local ]; then
  echo "❌ .env.local not found."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL is not set in .env.local."
  echo "   Copy it from Supabase: Settings -> Database -> Connection string -> Session pooler (IPv4)."
  exit 1
fi

echo "Testing direct Postgres connection (the TablePlus path)..."
psql "$DATABASE_URL" -c "select now() as server_time;" -c "\dt public.*"
echo "✅ Direct Postgres connection works. These are the same credentials TablePlus needs."
