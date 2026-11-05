#!/usr/bin/env bash
# The #173 demo rehearsal's one door to a database. Every rehearsal command runs through here, against the
# exclusive local stack w9-m365cap (API 127.0.0.1:57321, DB 127.0.0.1:57322) and against nothing else.
#
#   scripts/rehearsal/rehearse.sh status                 the pinned host:port pair, never a key
#   scripts/rehearsal/rehearse.sh names                  the variable names a child receives, never a value
#   scripts/rehearsal/rehearse.sh reset                  supabase db reset of w9-m365cap, migrations from this worktree
#   scripts/rehearsal/rehearse.sh seed [--team-inbox]    flags, users and the demo Gmail twin (e2e-team-inbox.yml:80-97);
#                                                        prints `seed <script> ok` per script, never the scripts' output
#   scripts/rehearsal/rehearse.sh sql                    the step-1 SQL negatives (team_mailboxes, discovery_promotion)
#   scripts/rehearsal/rehearse.sh e2e                    hermetic-team-inbox-demo under heavy, CI=1, --retries=0
#                                                        (REHEARSAL_BROWSER_LIBS=<dir>: Chromium libraries for this host)
#   scripts/rehearsal/rehearse.sh serve                  next build under heavy with the pinned env, a check that the build
#                                                        carries 127.0.0.1:57321 and no hosted project, then next start on
#                                                        127.0.0.1:3000 under the app stamp, for probe remove|health
#                                                        (the build's output: ~/.pr-review/scratch/cdt-173/serve-build.log)
#                                                        It builds into this worktree's own .next, replacing any build there.
#   scripts/rehearsal/rehearse.sh probe <sub> [args]     scripts/rehearsal/probes.ts <sub>: one JSON line. remove and
#                                                        health call the app, so they run only when the process on
#                                                        127.0.0.1:3000 is the one the app stamp names -> else app_not_owned
#
# The order is fixed (design R14):
#   1. .env* refusal   any .env* at the worktree root other than .env.example -> env_file_present. Existence only:
#                      no .env* file is read. Next's build and start load .env.local on their own, so a hosted value
#                      the allow-list leaves out could otherwise come back from the file.
#   2. local status    `supabase status -o env --workdir $W9_WORKDIR`, read-only, itself under env -i. W9_WORKDIR is
#                      the worktree whose config.toml carries project_id w9-m365cap; from this worktree a plain
#                      `supabase status` would describe the 54321 stack instead.
#   3. pin             API_URL exactly http://127.0.0.1:57321 and DB_URL exactly the postgres user on
#                      127.0.0.1:57322 -> else stack_mismatch. A wrong W9_WORKDIR fails here, closed.
#   4. port check      e2e and serve only: :3000, :4310 or :4311 already bound -> port_bound. Under CI=1 Playwright refuses a
#                      port bound mid-run too, instead of reusing another session's server (G-08).
#   5. exec env -i     an allow-list (scripts/rehearsal/stack.ts REHEARSAL_ENV_NAMES) and the child. Scripts are
#                      called as `node --import tsx <file>`: never `npm run`, never `--env-file`.
#
# AI_GATEWAY_API_KEY is never on the allow-list, so no child can reach the gateway. SEED_PASSWORD and
# INVITE_VERIFICATION_PEPPER are fixed local values, like the CI workflow's, never the shell's. A refusal prints
# `rehearse: refused <code>` on stderr (and host:port at most) and exits 2. Values are never echoed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
W9_WORKDIR="${W9_WORKDIR:-$HOME/.pr-review/scratch/w9-m365cap}"
HEAVY="$HOME/bin/heavy"
# The rehearsal's scratch, outside the repository: the app stamp lives here.
STATE_DIR="$HOME/.pr-review/scratch/cdt-173"
APP_STAMP="$STATE_DIR/app.stamp"
APP_PORT=3000

PIN_STACK='w9-m365cap'
PIN_API='http://127.0.0.1:57321'
PIN_DB='postgresql://postgres:postgres@127.0.0.1:57322/postgres'
E2E_PORTS=(3000 4310 4311)
TEAM_INBOX='deals@bank.example'

# Fixed local values (Proposed: the CI workflow's pattern, so a reset stack signs in with what it was seeded with).
SEED_PASSWORD_LOCAL='rehearsal-w9-password'
PEPPER_LOCAL='rehearsal-w9-pepper'

usage() {
  echo 'usage: rehearse.sh status | names | reset | seed [--team-inbox] | sql | e2e | serve | probe <sub> [args]' >&2
  exit 2
}

refuse() {
  echo "rehearse: refused $1${2:+ ($2)}" >&2
  exit 2
}

# host:port of a URL, without its scheme, userinfo or path: the most a refusal may name.
hostport() {
  local rest="${1#*://}"
  rest="${rest##*@}"
  printf '%s' "${rest%%/*}"
}

# 0. The command line, before anything is read.
cmd="${1:-}"
[[ $# -gt 0 ]] && shift
team=0
case "$cmd" in
  status | names | reset | sql | e2e | serve) [[ $# -eq 0 ]] || usage ;;
  seed)
    if [[ $# -eq 1 && "$1" == '--team-inbox' ]]; then team=1; elif [[ $# -ne 0 ]]; then usage; fi
    ;;
  probe) [[ $# -ge 1 ]] || usage ;;
  *) usage ;;
esac

# 1. Any .env* other than .env.example, by existence only.
for f in "$ROOT"/.env*; do
  [[ -e "$f" || -L "$f" ]] || continue
  [[ "$(basename "$f")" == '.env.example' ]] && continue
  refuse env_file_present
done

# 2. The local values, read-only, from w9-m365cap's own worktree.
status_text="$(env -i PATH="$PATH" HOME="$HOME" supabase status -o env --workdir "$W9_WORKDIR" 2>/dev/null)" ||
  refuse status_unavailable
st_api='' st_db='' st_anon='' st_service=''
while IFS= read -r line || [[ -n "$line" ]]; do
  key="${line%%=*}"
  value="${line#*=}"
  value="${value#\"}"
  value="${value%\"}"
  case "$key" in
    API_URL) st_api="$value" ;;
    DB_URL) st_db="$value" ;;
    ANON_KEY) st_anon="$value" ;;
    SERVICE_ROLE_KEY) st_service="$value" ;;
  esac
done <<<"$status_text"

# 3. The pin: exact strings, so userinfo, another port, a path or a query all fail.
[[ "$st_api" == "$PIN_API" ]] || refuse stack_mismatch "api $(hostport "$st_api")"
[[ "$st_db" == "$PIN_DB" ]] || refuse stack_mismatch "db $(hostport "$st_db")"
[[ -n "$st_anon" && -n "$st_service" ]] || refuse stack_keys_missing

# 5. The allow-list. Nothing else from this shell reaches a child.
child_env=("PATH=$PATH" "HOME=$HOME")
[[ -n "${TMPDIR+x}" ]] && child_env+=("TMPDIR=$TMPDIR")
[[ -n "${LANG+x}" ]] && child_env+=("LANG=$LANG")
child_env+=(
  "NEXT_PUBLIC_SUPABASE_URL=$st_api"
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$st_anon"
  "SUPABASE_SECRET_KEY=$st_service"
  "DATABASE_URL=$st_db"
  "SEED_PASSWORD=$SEED_PASSWORD_LOCAL"
  "INVITE_VERIFICATION_PEPPER=$PEPPER_LOCAL"
  "NEXT_PUBLIC_APP_ENV=dev"
  "NEXT_TELEMETRY_DISABLED=1"
  "REHEARSAL_STACK=$PIN_STACK"
  # A ~/.pg_service.conf or ~/.pgpass can never redirect or authenticate a psql child.
  "PGSERVICEFILE=/dev/null"
  "PGPASSFILE=/dev/null"
)

cd "$ROOT"
node_child() { env -i "${child_env[@]}" node --import tsx "$@"; }

# One seed script, its output withheld (seed output names people and addresses): a fixed line, or a fixed failure.
seed_step() {
  local name
  name="$(basename "$1" .ts)"
  if node_child "$@" >/dev/null 2>&1; then
    echo "seed $name ok"
  else
    local status=$?
    echo "rehearse: seed failed ($name, exit $status)" >&2
    exit 1
  fi
}

# The app a probe may call: the stamp's process must be alive and must be the listener on 127.0.0.1:3000. The stamp
# is `pid=<n> port=3000`, written by `rehearse.sh serve` once it has found the port free. Anything else, including
# another session's server on :3000, refuses before the probe signs anyone in.
app_owned() {
  local stamp pid
  [[ -f "$APP_STAMP" ]] || refuse app_not_owned
  stamp="$(<"$APP_STAMP")"
  [[ "$stamp" =~ ^pid=([0-9]+)\ port=${APP_PORT}$ ]] || refuse app_not_owned
  pid="${BASH_REMATCH[1]}"
  kill -0 "$pid" 2>/dev/null || refuse app_not_owned
  command -v ss >/dev/null 2>&1 || refuse port_check_unavailable
  local listening
  listening="$(ss -ltnpH 2>/dev/null)" || refuse port_check_unavailable
  awk -v want="127.0.0.1:${APP_PORT}" -v owner="pid=${pid}," '$4 == want && index($0, owner) { found = 1 } END { exit !found }' \
    <<<"$listening" || refuse app_not_owned
}

port_check() {
  command -v ss >/dev/null 2>&1 || refuse port_check_unavailable
  local listening port
  listening="$(ss -ltnH 2>/dev/null)" || refuse port_check_unavailable
  for port in "$@"; do
    if awk '{ print $4 }' <<<"$listening" | grep -Eq "[:.]${port}\$"; then refuse port_bound ":$port"; fi
  done
}

case "$cmd" in
  status)
    printf '%s %s\n' "$(hostport "$st_api")" "$(hostport "$st_db")"
    ;;
  names)
    env -i "${child_env[@]}" env | sed 's/=.*//' | LC_ALL=C sort
    ;;
  reset)
    exec env -i "${child_env[@]}" supabase db reset --yes --db-url "$PIN_DB?sslmode=disable"
    ;;
  seed)
    seed_step scripts/seed-flags.ts
    seed_step scripts/enable-flags.ts
    seed_step scripts/seed-users.ts
    # Storm and Alex get no personal source: the journey connects the team inbox through the admin card.
    discovery=(scripts/seed-discovery.ts --google-replay --corpus demo --phase seeded --personas morgan)
    # Proposed: --team-inbox connects and verifies it here, so the probes can run without the browser
    # (team-inbox-guide.md:170-194). The journey needs a stack seeded without it.
    [[ "$team" == 1 ]] && discovery+=(--team-inbox "$TEAM_INBOX" --team-members storm)
    seed_step "${discovery[@]}"
    ;;
  sql)
    for file in supabase/tests/team_mailboxes.sql supabase/tests/discovery_promotion.sql; do
      env -i "${child_env[@]}" psql "$st_db" -X -v ON_ERROR_STOP=1 -f "$file"
    done
    ;;
  e2e)
    # 4. Another session's server on these ports would otherwise be reused, pointed at another stack.
    port_check "${E2E_PORTS[@]}"
    [[ -x "$HEAVY" ]] || refuse heavy_missing
    # A host without Chromium's system libraries (libatk and friends) can point REHEARSAL_BROWSER_LIBS at a
    # directory of them extracted from the distro's packages. Scope: it becomes LD_LIBRARY_PATH for the whole e2e
    # child, not Chromium alone: the Playwright runner, its webServers (next build and start, the two stubs), the
    # scripts the journey spawns, and the browser. None of the other commands get it. It only adds a search
    # directory, so put nothing in it but the extracted distro libraries; narrowing it to Chromium would mean
    # launchOptions.env in playwright.config.ts, which this wrapper does not own.
    browser_env=()
    if [[ -n "${REHEARSAL_BROWSER_LIBS:-}" ]]; then
      [[ -d "$REHEARSAL_BROWSER_LIBS" ]] || refuse browser_libs_missing
      browser_env=("LD_LIBRARY_PATH=$REHEARSAL_BROWSER_LIBS")
    fi
    # Traces, videos and reports stay local and are never copied (R5): a stale one never counts as this run's
    # evidence, and this run's are gone however it ends (exit, Ctrl-C, TERM).
    clean_reports() { rm -rf "$ROOT/test-results" "$ROOT/playwright-report" "$ROOT/e2e-results.json"; }
    clean_reports
    trap clean_reports EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    set +e
    "$HEAVY" --kind e2e -- env -i "${child_env[@]}" "${browser_env[@]}" CI=1 \
      npx playwright test --project=hermetic-team-inbox-demo --retries=0
    result=$?
    set -e
    # The journey's own evidence for the gap list: the invite-only counts and the known-gap witnesses, which hold
    # counts and fixed codes only. No other annotation type is printed, and a file that does not parse prints a fixed
    # line, never the parse error (which can quote the file).
    if [[ -f "$ROOT/e2e-results.json" ]]; then
      env -i PATH="$PATH" node -e '
        let lines;
        try {
          const walk = (s) => [...(s.specs ?? []).flatMap((p) => p.tests.flatMap((t) => t.annotations ?? [])),
                               ...(s.suites ?? []).flatMap(walk)];
          const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          lines = r.suites.flatMap(walk)
            .filter((a) => a.type === "invite-only" || a.type === "known-gap")
            .map((a) => `annotation ${a.type}: ${a.description}`);
        } catch {
          lines = ["rehearse: annotations unreadable"];
        }
        for (const line of lines) console.log(line);' "$ROOT/e2e-results.json" 2>/dev/null || true
    fi
    exit "$result"
    ;;
  serve)
    # The app, over the journey's state (Playwright stops its own server), so the probes that call it (remove,
    # health) can read what the journey left. Foreground; stop it by its PID. It never reuses a build it did not make:
    # NEXT_PUBLIC_* are inlined at build time, so a build from another env would talk to another stack.
    rm -f "$APP_STAMP"
    port_check "$APP_PORT"
    [[ -x "$HEAVY" ]] || refuse heavy_missing
    # The non-blank values of playwright.config.ts's webServer env, so the app answers as it did in the journey.
    app_env=(DISABLE_MFA=1 MFA_ENFORCEMENT=invite_only STORAGE_PROVIDER=local EMAIL_PROVIDER=noop)
    # The build's output goes to a log in the rehearsal's scratch (outside the repository), so a refusal is a code.
    mkdir -p -m 700 "$STATE_DIR"
    "$HEAVY" --kind node-build -- env -i "${child_env[@]}" "${app_env[@]}" node node_modules/next/dist/bin/next build \
      >"$STATE_DIR/serve-build.log" 2>&1 || refuse build_failed
    [[ -f "$ROOT/.next/BUILD_ID" ]] || refuse build_failed
    # The build must carry the pinned API and name no hosted project (a 20-character project ref; the bundled CSP's
    # *.supabase.co wildcard is not one).
    grep -rqF "$(hostport "$PIN_API")" "$ROOT/.next/static" 2>/dev/null || refuse build_mismatch "no $(hostport "$PIN_API")"
    if grep -rqE '[a-z0-9]{20}\.supabase\.co' "$ROOT/.next/static" "$ROOT/.next/server" 2>/dev/null; then
      refuse build_mismatch 'hosted project'
    fi
    # The stamp names this process: exec keeps the pid through env and node, so it is the listener app_owned checks.
    printf 'pid=%s port=%s\n' "$$" "$APP_PORT" >"$APP_STAMP"
    exec env -i "${child_env[@]}" "${app_env[@]}" node node_modules/next/dist/bin/next start --port "$APP_PORT" --hostname 127.0.0.1
    ;;
  probe)
    case "$1" in remove | health) app_owned ;; esac
    exec env -i "${child_env[@]}" node --import tsx scripts/rehearsal/probes.ts "$@"
    ;;
esac
