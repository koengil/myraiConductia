#!/usr/bin/env bash
# Stand up the #162 throwaway Supabase stack: project_id "cdt162-rail", every
# port shifted +2000 from the tracked config (56321 API, 56322 DB, …), so it
# never collides with the default `conductia` stack or any other developer's
# stack on this host. Never touches another stack.
#
# The project id and the API/DB ports come from scripts/perf/localStack.mjs
# (the guard's single source); the shifted config must agree with them or
# this refuses before starting anything.
#
#   scripts/perf/rail-stack.sh            # start (or reuse), db reset, pg_stat_statements, env file
#   scripts/perf/rail-stack.sh --no-reset # skip the db reset on a running stack
#   supabase stop --workdir /tmp/cdt162-stack   # when done
#
# Writes /tmp/cdt162-stack/env (0600): the local stack's URL and demo keys for
# scripts/perf/with-local-stack.sh. Nothing secret is printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="${CDT162_STACK_DIR:-/tmp/cdt162-stack}"
SHIFT=2000
# "<project id> <API port> <DB port>" from localStack.mjs, never restated here.
STACK_IDENTITY="$(env -i PATH="$PATH" node "$HERE/stack-identity.mjs" ports)"
read -r PROJECT_ID API_PORT DB_PORT <<<"$STACK_IDENTITY"
[[ -n "${PROJECT_ID:-}" && "${API_PORT:-}" =~ ^[0-9]+$ && "${DB_PORT:-}" =~ ^[0-9]+$ ]] || {
  echo "rail-stack: could not read the stack identity from localStack.mjs" >&2
  exit 1
}
RESET=1
[[ "${1:-}" == "--no-reset" ]] && RESET=0

# Every docker and supabase call below must reach this host's daemon only.
# shellcheck source=scripts/perf/stack-check.sh
source "$HERE/stack-check.sh"
require_local_docker || exit 1

# The supabase CLI runs with a minimal environment too: no hosted token,
# no hosted URL, nothing the profile exports beyond what docker needs.
cli() {
  local pass=(PATH="$PATH" HOME="$HOME")
  [[ -n "${DOCKER_CONFIG+x}" ]] && pass+=(DOCKER_CONFIG="$DOCKER_CONFIG")
  env -i "${pass[@]}" supabase "$@" --workdir "$WORKDIR"
}

mkdir -p "$WORKDIR"
chmod 700 "$WORKDIR"

# 1. A private copy of supabase/ (migrations + config), never the tracked one.
rm -rf "$WORKDIR/supabase.next"
mkdir -p "$WORKDIR/supabase.next"
(cd "$ROOT/supabase" && tar --exclude=.temp --exclude=.branches -cf - .) | (cd "$WORKDIR/supabase.next" && tar -xf -)

CONFIG="$WORKDIR/supabase.next/config.toml"
# project_id and every port line (port, shadow_port, inspector_port) shifted.
sed -i -E "s/^project_id = \".*\"/project_id = \"$PROJECT_ID\"/" "$CONFIG"
awk -v shift="$SHIFT" '
  /^[[:space:]]*(port|shadow_port|inspector_port|smtp_port|pop3_port)[[:space:]]*=[[:space:]]*[0-9]+/ {
    match($0, /[0-9]+[[:space:]]*$/)
    num = substr($0, RSTART, RLENGTH) + 0
    print substr($0, 1, RSTART - 1) (num + shift)
    next
  }
  { print }
' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
# The harness mints one fresh session per run (refresh-token rotation makes a
# reused session unsafe for the near-expiry variant); lift the local
# sign-in rate limit on this throwaway stack only.
sed -i -E 's/^sign_in_sign_ups = [0-9]+/sign_in_sign_ups = 5000/' "$CONFIG"

grep -q "^project_id = \"$PROJECT_ID\"" "$CONFIG" || { echo "rail-stack: project_id rewrite failed" >&2; exit 1; }
# The first `port =` line under a [section] header.
section_port() {
  awk -v want="[$1]" '
    /^\[/ { inside = ($0 == want) }
    inside && /^[[:space:]]*port[[:space:]]*=/ { match($0, /[0-9]+/); print substr($0, RSTART, RLENGTH); exit }
  ' "$CONFIG"
}
CFG_API_PORT="$(section_port api)"
CFG_DB_PORT="$(section_port db)"
if [[ "$CFG_API_PORT" != "$API_PORT" || "$CFG_DB_PORT" != "$DB_PORT" ]]; then
  echo "rail-stack: shifted config ports (api ${CFG_API_PORT:-?}, db ${CFG_DB_PORT:-?}) disagree with localStack.mjs (api $API_PORT, db $DB_PORT)" >&2
  exit 1
fi
PORTS=$(grep -E '^[[:space:]]*(port|shadow_port|inspector_port)[[:space:]]*=' "$CONFIG" | grep -oE '[0-9]+' | sort -u | tr '\n' ' ')
echo "rail-stack: project_id=$PROJECT_ID ports: $PORTS"
for p in $PORTS; do
  case "$p" in
    54321|54322|55321|55322|55521|55522|54801|54802)
      echo "rail-stack: refusing, port $p belongs to another stack" >&2; exit 1 ;;
  esac
done

running=0
if cli status >/dev/null 2>&1; then running=1; fi

if [[ "$running" == "0" ]]; then
  for p in $PORTS; do
    if ss -ltnH "( sport = :$p )" | grep -q .; then
      echo "rail-stack: port $p is already in use; refusing to start" >&2
      exit 1
    fi
  done
fi

rm -rf "$WORKDIR/supabase"
mv "$WORKDIR/supabase.next" "$WORKDIR/supabase"

# 2. Start. Only what the rail path needs: db, auth, rest, kong (+ mailpit).
# The CLI's start banner prints the local keys; drop those lines.
redact() { grep -vE 'sb_(publishable|secret)_|eyJ[A-Za-z0-9_-]{10,}|Publishable|Secret|anon key|service_role' || true; }
if [[ "$running" == "0" ]]; then
  cli start --exclude studio,postgres-meta,edge-runtime,realtime,logflare,vector,imgproxy,storage-api,supavisor 2>&1 | redact
fi
# Before the reset (or anything else that writes): the containers on the
# expected ports must be this stack's, whether it was just started or reused.
require_running_stack || {
  echo "rail-stack: the running stack is not the expected throwaway stack; refusing to reset or write" >&2
  exit 1
}
if [[ "$RESET" == "1" ]]; then
  cli db reset --local 2>&1 | grep -v '^Applying migration' | redact
fi

# 3. The env file. Values come from `supabase status -o env`; only loopback.
STATUS_ENV="$(cli status -o env 2>/dev/null)"
val() { printf '%s\n' "$STATUS_ENV" | sed -n -E "s/^$1=\"?([^\"]*)\"?$/\1/p" | head -n1; }
API_URL="$(val API_URL)"
DB_URL="$(val DB_URL)"
PUB_KEY="$(val PUBLISHABLE_KEY)"; [[ -n "$PUB_KEY" ]] || PUB_KEY="$(val ANON_KEY)"
SECRET_KEY="$(val SECRET_KEY)"; [[ -n "$SECRET_KEY" ]] || SECRET_KEY="$(val SERVICE_ROLE_KEY)"
[[ "$API_URL" == "http://127.0.0.1:$API_PORT" ]] || { echo "rail-stack: unexpected API_URL host/port" >&2; exit 1; }
[[ "$DB_URL" == postgresql://*@127.0.0.1:$DB_PORT/postgres ]] || { echo "rail-stack: unexpected DB_URL host/port" >&2; exit 1; }
[[ -n "$PUB_KEY" && -n "$SECRET_KEY" ]] || { echo "rail-stack: keys missing from supabase status" >&2; exit 1; }

ENV_FILE="$WORKDIR/env"
SEED_PASSWORD_VALUE=""
if [[ -f "$ENV_FILE" ]]; then
  SEED_PASSWORD_VALUE="$(sed -n -E 's/^SEED_PASSWORD=(.*)$/\1/p' "$ENV_FILE" | head -n1)"
fi
[[ -n "$SEED_PASSWORD_VALUE" ]] || SEED_PASSWORD_VALUE="perf-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"

umask 077
{
  echo "PERF_STACK_PROJECT_ID=$PROJECT_ID"
  echo "NEXT_PUBLIC_SUPABASE_URL=$API_URL"
  echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$PUB_KEY"
  echo "SUPABASE_SECRET_KEY=$SECRET_KEY"
  echo "DATABASE_URL=$DB_URL"
  echo "SEED_PASSWORD=$SEED_PASSWORD_VALUE"
  # Seeded accounts are not invite-born, so invite_only keeps them at AAL1
  # without the dev MFA bypass (which needs NEXT_PUBLIC_APP_ENV=dev; the
  # measured build keeps NEXT_PUBLIC_APP_ENV unset, as production does).
  echo "MFA_ENFORCEMENT=invite_only"
  echo "STORAGE_PROVIDER=local"
  echo "EMAIL_PROVIDER=noop"
  echo "NEXT_TELEMETRY_DISABLED=1"
} > "$ENV_FILE.tmp"
chmod 600 "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "rail-stack: wrote $ENV_FILE (0600)"

# 4. pg_stat_statements on THIS database only (never a migration). --write
# confirms the running containers are this stack's before the extension lands.
"$HERE/with-local-stack.sh" --stack-env "$ENV_FILE" --write \
  node --import tsx "$HERE/pg-stat.ts" enable
