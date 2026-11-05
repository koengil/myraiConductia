#!/bin/sh
# The worker image's entrypoints (worker/Dockerfile).
#   classify       the long-running classification consumer (pg-boss)
#   classify-once  one pass over every active registration, then exit
#   extract        the deal-zone worker (milestone extraction, phase 6)
#   estimate       the extractor's dry run (#261): one JSON line of byte
#                  statistics and the expected cost, no model call
#   detect         the rule detector's run (#173 G-07): extract.mjs --rules,
#                  no model call; one JSON line of integers and fixed codes
#   probe          the Google connection probe, run from the task (#344,
#                  design R15); its arguments are the probe task family's
#                  fixed command, its two test addresses come from env
#   self-check     writes the Google configs as below, prints the uid and the
#                  file modes (never their content), then exits 0
#
# Before any entry runs (#344, design R6): ECS injects the two workload
# identity configs as GOOGLE_WIF_DWD_CONFIG and GOOGLE_WIF_DIRECTORY_CONFIG.
# Each one present is written to a 0600 file under /tmp/google (the image's
# one writable path under a read-only root), the path variable the reader
# reads is exported, and the raw variables are unset, so the node process
# never holds them in its environment. Neither present: nothing changes, and
# GOOGLE_APPLICATION_CREDENTIALS passes through as given (a laptop run).
set -eu

config_dir="${WORKER_GOOGLE_CONFIG_DIR:-/tmp/google}"

# write_config <file name> <value>. printf is a shell builtin, so the value is
# never an argument of another process.
write_config() {
  { mkdir -p "$config_dir" && chmod 0700 "$config_dir" && rm -f "$config_dir/$1"; } 2>/dev/null || {
    echo "entrypoint: $config_dir is not writable by uid $(id -u)" >&2
    exit 70
  }
  (umask 077 && printf '%s' "$2" > "$config_dir/$1")
}

if [ -n "${GOOGLE_WIF_DWD_CONFIG:-}" ]; then
  write_config dwd.json "$GOOGLE_WIF_DWD_CONFIG"
  export GOOGLE_APPLICATION_CREDENTIALS="$config_dir/dwd.json"
fi
if [ -n "${GOOGLE_WIF_DIRECTORY_CONFIG:-}" ]; then
  write_config directory.json "$GOOGLE_WIF_DIRECTORY_CONFIG"
  export GOOGLE_DIRECTORY_CREDENTIALS="$config_dir/directory.json"
fi
unset GOOGLE_WIF_DWD_CONFIG GOOGLE_WIF_DIRECTORY_CONFIG

entry="${1:-classify}"
[ "$#" -gt 0 ] && shift
case "$entry" in
  classify) exec node dist/worker/classify.mjs --serve "$@" ;;
  classify-once) exec node dist/worker/classify.mjs "$@" ;;
  extract)
    if [ -f dist/worker/extract.mjs ]; then exec node dist/worker/extract.mjs --serve "$@"; fi
    echo "The extract entrypoint arrives with the milestone extractor (phase 6)." >&2
    exit 64 ;;
  estimate)
    if [ -f dist/worker/extract.mjs ]; then exec node dist/worker/extract.mjs --estimate "$@"; fi
    echo "The estimate entrypoint arrives with the milestone extractor (phase 6)." >&2
    exit 64 ;;
  detect)
    if [ -f dist/worker/extract.mjs ]; then exec node dist/worker/extract.mjs --rules "$@"; fi
    echo "The detect entrypoint needs the extractor bundle (dist/worker/extract.mjs)." >&2
    exit 64 ;;
  probe) exec node dist/worker/probe.mjs "$@" ;;
  self-check)
    echo "uid $(id -u)"
    for name in dwd.json directory.json; do
      if [ -f "$config_dir/$name" ]; then
        echo "$name $(stat -c '%a' "$config_dir/$name")"
      else
        echo "$name absent"
      fi
    done
    exit 0 ;;
  *)
    echo "usage: classify | classify-once | extract | estimate | detect | probe | self-check" >&2
    exit 64 ;;
esac
