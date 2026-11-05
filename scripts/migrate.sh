#!/usr/bin/env bash
set -euo pipefail

# Applies every SQL migration in supabase/migrations/ (in filename order) via psql.
# This is the terminal alternative to pasting into the Supabase SQL Editor — no
# TablePlus required.
#
# Prereq: DATABASE_URL set in the target env file (Supabase -> Settings ->
# Database -> Connection string -> Session pooler).
#
#   npm run db:migrate                        # .env.local (Conductia-dev)
#   bash scripts/migrate.sh .env.production   # an explicitly named target
#
# This replays EVERY file. That builds an empty database (local, a new
# project), but it is not safe over a lived-in one. Some files are not
# re-runnable: an unguarded add column in 20260808120000, and validated CHECK
# re-adds from 20260721120000 on that live audit_log rows no longer satisfy.
# A full replay fails partway and leaves the earlier files re-applied, and it
# writes no ledger. Hosted databases are migrated by the Migrate database
# workflow (.github/workflows/migrate.yml), never by this script
# (docs/04-operations/production-bootstrap.md).

ENV_FILE="${1:-.env.local}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "❌ ${ENV_FILE} not found."
  exit 1
fi

# Load only DATABASE_URL — do not `source` the env file. Values like
# RESEND_FROM=Name <email@example.com> and passwords containing * break bash.
DATABASE_URL="$(node --env-file="${ENV_FILE}" -e "process.stdout.write(process.env.DATABASE_URL ?? '')")"

if [ -z "${DATABASE_URL}" ]; then
  echo "❌ DATABASE_URL is not set in ${ENV_FILE}."
  echo "   Copy it from Supabase: Settings -> Database -> Connection string -> Session pooler (IPv4)."
  exit 1
fi

# Say which database is about to be rewritten before rewriting it. Every other
# script in this repo defaults to .env.local, so the failure mode this guards
# against is replaying migrations onto the dev project while believing they are
# going somewhere else — or the reverse.
DB_HOST="$(node -e "process.stdout.write(new URL(process.argv[1]).host)" "${DATABASE_URL}")"
echo "Target: ${DB_HOST} (from ${ENV_FILE})"

# A named target is a deliberate act; the default one is the daily dev loop and
# stays frictionless. MIGRATE_CONFIRM=1 covers non-interactive callers.
if [ "${ENV_FILE}" != ".env.local" ] && [ "${MIGRATE_CONFIRM:-}" != "1" ]; then
  read -r -p "Apply all migrations to ${DB_HOST}? Type the host to confirm: " reply
  if [ "${reply}" != "${DB_HOST}" ]; then
    echo "❌ Aborted."
    exit 1
  fi
fi

shopt -s nullglob
files=(supabase/migrations/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "No migration files found in supabase/migrations/."
  exit 0
fi

for f in "${files[@]}"; do
  echo "→ Applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "✅ ${#files[@]} migrations applied to ${DB_HOST}."
