#!/usr/bin/env bash
# Reports which Content-Security-Policy header an environment serves.
#
#   scripts/csp-smoke.sh https://app.conductia.com https://<project-ref>.supabase.co
#   scripts/csp-smoke.sh http://127.0.0.1:3000
#
# The second argument is the Supabase origin the target environment was built
# with. connect-src must be exactly 'self' plus that origin, so a build carrying
# another environment's Supabase origin fails. Without the argument the script
# falls back to NEXT_PUBLIC_SUPABASE_URL and prints which source it used; check
# that it names the target's project, since a shell profile may export another
# environment's value. A non-loopback target with neither fails.
#
# Three unauthenticated paths are probed (outside the auth middleware, so they
# answer without a session): a page with no layout state, a public page, and a
# static asset. For each it prints "enforced", "report-only" or "MISSING", then
# checks the directives the policy exists for.
#
# Exit 0: every path carries a CSP header (enforced or report-only) with the key
# directives. Exit 1: a path has no CSP header, a key directive is absent, or
# connect-src is not exactly 'self' plus the expected origin.
# Read the printed word, not the exit code, to tell enforced from report-only.
#
# VERCEL_PROTECTION_BYPASS, when set, is sent as x-vercel-protection-bypass for
# protected Vercel environments. Its value is never printed.
set -u

if [ $# -lt 1 ] || [ $# -gt 2 ] || [ -z "$1" ]; then
  echo "usage: $0 <base-url> [expected-supabase-origin]" >&2
  exit 2
fi

base="${1%/}"
paths=(/sign-in /terms /conductia/email/conductia-mark-ink.png)

curl_args=(-sI --max-time 20)
if [ -n "${VERCEL_PROTECTION_BYPASS:-}" ]; then
  curl_args+=(-H "x-vercel-protection-bypass: ${VERCEL_PROTECTION_BYPASS}")
fi

# scheme://host[:port], lowercased, with any path or trailing slash dropped.
origin_of() {
  local value="${1%%\?*}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    http://* | https://*) ;;
    *) return 1 ;;
  esac
  local scheme="${value%%://*}"
  local rest="${value#*://}"
  rest="${rest%%/*}"
  [ -n "$rest" ] || return 1
  printf '%s://%s' "$scheme" "$rest"
}

host="${base#*://}"
host="${host%%/*}"
host="${host%%:*}"
case "$host" in
  127.0.0.1 | localhost | "[::1]" | "::1") loopback=1 ;;
  *) loopback=0 ;;
esac

expected=""
if [ -n "${2:-}" ]; then
  expected_source="argument"
  expected_raw="$2"
elif [ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" ]; then
  expected_source="NEXT_PUBLIC_SUPABASE_URL"
  expected_raw="$NEXT_PUBLIC_SUPABASE_URL"
else
  expected_source=""
  expected_raw=""
fi
if [ -n "$expected_raw" ]; then
  if ! expected="$(origin_of "$expected_raw")"; then
    echo "expected Supabase origin is not an http(s) URL (from ${expected_source})" >&2
    exit 2
  fi
  echo "expected connect-src: 'self' ${expected}  (from ${expected_source})"
elif [ "$loopback" -eq 1 ]; then
  # A local build against a local stack: nothing to compare without an origin.
  echo "expected connect-src: not checked (loopback target, no expected origin given)"
else
  echo "expected connect-src: unknown; pass the target's Supabase origin as the second argument" >&2
fi

status=0
kinds=""

for path in "${paths[@]}"; do
  url="${base}${path}"
  if ! response="$(curl "${curl_args[@]}" "$url" 2>/dev/null)"; then
    echo "MISSING  ${path}  (no response)"
    status=1
    kinds="${kinds} missing"
    continue
  fi
  response="$(printf '%s' "$response" | tr -d '\r')"

  enforced="$(printf '%s\n' "$response" | grep -i '^content-security-policy:' | head -n 1 | cut -d: -f2- | sed 's/^ *//')"
  report_only="$(printf '%s\n' "$response" | grep -i '^content-security-policy-report-only:' | head -n 1 | cut -d: -f2- | sed 's/^ *//')"

  if [ -n "$enforced" ]; then
    kind="enforced"
    policy="$enforced"
  elif [ -n "$report_only" ]; then
    kind="report-only"
    policy="$report_only"
  else
    echo "MISSING  ${path}"
    status=1
    kinds="${kinds} missing"
    continue
  fi
  kinds="${kinds} ${kind}"

  problems=""
  case "$policy" in
    *"img-src 'self' data:"*) ;;
    *) problems="${problems} img-src-not-'self'-data:" ;;
  esac
  case "$policy" in
    *"frame-ancestors 'none'"*) ;;
    *) problems="${problems} frame-ancestors-not-'none'" ;;
  esac
  if [ -n "$expected" ]; then
    # Exactly 'self' plus the expected origin, in any order: a wrong origin, a
    # missing one or an extra one all fail.
    connect="$(printf '%s' "$policy" | tr ';' '\n' | sed 's/^ *//' | grep '^connect-src' | head -n 1)"
    actual="$(printf '%s' "${connect#connect-src}" | tr ' ' '\n' | sed '/^$/d' | sed 's#/$##' | tr '[:upper:]' '[:lower:]' | sort | tr '\n' ' ')"
    wanted="$(printf "'self'\n%s\n" "$expected" | sort | tr '\n' ' ')"
    if [ "$actual" != "$wanted" ]; then
      problems="${problems} connect-src-is-not-'self'+${expected}(got:${connect#connect-src})"
    fi
  elif [ "$loopback" -eq 0 ]; then
    problems="${problems} no-expected-supabase-origin-to-compare-connect-src"
  fi

  if [ -n "$problems" ]; then
    echo "${kind}  ${path}  FAIL:${problems}"
    status=1
  else
    echo "${kind}  ${path}  ok"
  fi
done

if [ "$status" -ne 0 ]; then
  echo "result: FAIL"
elif printf '%s' "$kinds" | grep -q 'report-only'; then
  echo "result: report-only (CSP is NOT blocking anything)"
else
  echo "result: enforced"
fi
exit "$status"
