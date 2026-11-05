#!/usr/bin/env bash
# Run one command against the #162 throwaway Supabase stack, and nothing else.
#
#   scripts/perf/with-local-stack.sh [--stack-env FILE] [--write] <command> [args…]
#
# The child starts from an EMPTY environment (env -i). Only an explicit
# allowlist is copied from the parent, by name and only when set, plus the
# stack values from --stack-env (default /tmp/cdt162-stack/env, written 0600 by
# rail-stack.sh with local demo keys). A hosted or integration variable the
# shell profile exports (DATABASE_URL, SUPABASE_*, BOX_*, RESEND_*,
# ANTHROPIC_*, MFA_*, EMAIL_*, STORAGE_*, NEXT_PUBLIC_APP_ENV, …) therefore
# cannot reach the child unless the stack file names it.
#
# NODE_OPTIONS is never inherited. It is set to preload
# scripts/perf/assert-local-stack.mjs, so every node process under this wrapper
# (seed scripts, next, the harness, vitest workers) re-checks its own
# environment before running. The wrapper runs that check once itself before
# exec, so a non-node command (psql, bash) is covered too.
#
# --write is for anything that writes to the stack (seed-rail-scale.sh,
# set-local-flags.ts, pg-stat.ts enable/reset, rail-cold-load.ts). Before exec
# it confirms the RUNNING service is this stack: one `docker ps`, parsed by
# localStack.mjs's assertRunningStack, must show the API port published only
# by supabase_kong_cdt162-rail and the DB port only by supabase_db_cdt162-rail.
# Docker must be the local daemon: DOCKER_HOST, a non-default DOCKER_CONTEXT or
# a non-default current context is refused (stack-check.sh). It fails closed
# (docker unreachable, stack stopped, a foreign container on either port). Only then does the child get PERF_STACK_WRITE_CHECKED=1, which
# the TypeScript write paths require (assertWriteChecked). Read-only runs skip
# the docker call.
#
# psql children get PGSERVICEFILE=/dev/null and PGPASSFILE=/dev/null, so a
# ~/.pg_service.conf or ~/.pgpass can never redirect or authenticate them.
#
# Values are never echoed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STACK_ENV="${CDT162_STACK_ENV:-/tmp/cdt162-stack/env}"

WRITE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack-env)
      [[ $# -ge 2 ]] || { echo "with-local-stack: --stack-env needs a file" >&2; exit 2; }
      STACK_ENV="$2"
      shift 2
      ;;
    --write) WRITE=1; shift ;;
    *) break ;;
  esac
done
[[ $# -ge 1 ]] || { echo "usage: with-local-stack.sh [--stack-env FILE] [--write] <command> [args…]" >&2; exit 2; }
[[ -f "$STACK_ENV" ]] || { echo "with-local-stack: stack env file not found: $STACK_ENV (run scripts/perf/rail-stack.sh)" >&2; exit 2; }

# Copied from the parent by name, only when set. Nothing else crosses.
ALLOWLIST=(PATH HOME TMPDIR LANG TERM PLAYWRIGHT_BROWSERS_PATH CI)

child_env=()
for name in "${ALLOWLIST[@]}"; do
  if [[ -n "${!name+x}" ]]; then
    child_env+=("$name=${!name}")
  fi
done

# Stack values: NAME=value lines; blank lines and # comments are skipped.
# Names are validated; values are passed through verbatim and never printed.
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  if [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ || "$key" == "$line" ]]; then
    echo "with-local-stack: malformed line in $STACK_ENV (name '${key:0:40}')" >&2
    exit 2
  fi
  case "$key" in
    NODE_OPTIONS | PERF_STACK_WRITE_CHECKED | PGSERVICEFILE | PGPASSFILE)
      echo "with-local-stack: the stack file may not set $key" >&2
      exit 2
      ;;
  esac
  child_env+=("$line")
done < "$STACK_ENV"

# Plain .mjs: this host's node has no native TypeScript support (see localStack.mjs).
child_env+=("NODE_OPTIONS=--import $ROOT/scripts/perf/assert-local-stack.mjs")
child_env+=("PGSERVICEFILE=/dev/null" "PGPASSFILE=/dev/null")

# One check in the child's exact environment before handing over, so a
# non-node command cannot skip the guard. It prints the stack id and the
# host:port of every URL-bearing variable (never a credential) to stderr.
env -i "${child_env[@]}" PERF_ASSERT_VERBOSE=1 node -e "" || {
  echo "with-local-stack: the local-stack guard refused this environment" >&2
  exit 1
}

# The running service must be this stack, reached through the local docker
# daemon, before anything writes to it (require_running_stack).
# shellcheck source=scripts/perf/stack-check.sh
source "$HERE/stack-check.sh"

if [[ "$WRITE" == "1" ]]; then
  require_running_stack || {
    echo "with-local-stack: the running stack is not the expected throwaway stack; refusing a write" >&2
    exit 1
  }
  child_env+=("PERF_STACK_WRITE_CHECKED=1")
fi

exec env -i "${child_env[@]}" "$@"
