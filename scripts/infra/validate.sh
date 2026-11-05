#!/bin/sh
# Offline checks for every OpenTofu module under infra/ (infra/<module>/, each
# with an optional bootstrap/; #344 design R2 and R20, ADR-0027):
#   tofu fmt -check, init -backend=false, validate (root module and bootstrap/),
#   and tofu test against a mock AWS provider (root, and bootstrap/ when it has
#   tests/); then the Lambda unit tests, node --test infra/*/lambda/*.test.mjs
#   (#639: CI ran none of them before).
# It downloads the pinned providers and touches no account: it never plans or
# applies against AWS, and no AWS credential, profile or metadata endpoint
# reaches tofu.
#
#   scripts/infra/validate.sh                 # the check (CI's infra-validate job)
#   scripts/infra/validate.sh --update-lock   # after a provider bump: rewrite the
#                                             # .terraform.lock.hcl files
#
# Uses tofu from PATH when present (CI installs it with opentofu/setup-opentofu),
# else the pinned ghcr.io/opentofu/opentofu image through docker.
set -eu

TOFU_VERSION=1.13.1

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)

lockfile=readonly
case "${1:-}" in
  '') ;;
  --update-lock) lockfile=update ;;
  *) echo "usage: scripts/infra/validate.sh [--update-lock]" >&2; exit 64 ;;
esac

# Nothing from the caller's shell configures tofu or the AWS provider.
for name in $(env | sed -n 's/^\(AWS_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(TF_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true
export TF_IN_AUTOMATION=1

# Runs inside $module, locally or in the container. DATA is a scratch directory
# outside the repo, so no .terraform directory is left in the working tree.
checks='
set -eu
mkdir -p "$DATA/plugins"
export TF_PLUGIN_CACHE_DIR="$DATA/plugins"
echo "tofu fmt -check"
tofu fmt -check -recursive -diff
for dir in bootstrap .; do
  [ -d "$dir" ] || continue # bootstrap/ is optional (infra/deploy-runner has none)
  case "$dir" in bootstrap) data="$DATA/bootstrap" ;; *) data="$DATA/root" ;; esac
  if [ "$LOCKFILE" = update ]; then lock=""; else lock="-lockfile=readonly"; fi
  echo "tofu init -backend=false ($dir)"
  TF_DATA_DIR="$data" tofu -chdir="$dir" init -backend=false -input=false -no-color $lock >/dev/null
  echo "tofu validate ($dir)"
  TF_DATA_DIR="$data" tofu -chdir="$dir" validate -no-color
done
if [ -d bootstrap/tests ]; then
  echo "tofu test (bootstrap, mock provider)"
  TF_DATA_DIR="$DATA/bootstrap" tofu -chdir=bootstrap test -no-color
fi
echo "tofu test (mock provider)"
TF_DATA_DIR="$DATA/root" tofu test -no-color
'

run_checks() { # module directory
  module=$1
  echo "== ${module#"$root"/}"
  if command -v tofu >/dev/null 2>&1; then
    data=$(mktemp -d)
    (cd "$module" && DATA="$data" LOCKFILE="$lockfile" sh -c "$checks") || { rm -rf "$data"; return 1; }
    rm -rf "$data"
  else
    docker run --rm \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp -e DATA=/tmp/tofu -e LOCKFILE="$lockfile" -e TF_IN_AUTOMATION=1 \
      -e AWS_CONFIG_FILE=/dev/null -e AWS_SHARED_CREDENTIALS_FILE=/dev/null -e AWS_EC2_METADATA_DISABLED=true \
      -v "$module:/work" -w /work \
      --entrypoint sh "ghcr.io/opentofu/opentofu:$TOFU_VERSION" -c "$checks"
  fi
}

found=0
for module in "$root"/infra/*/; do
  module=${module%/}
  ls "$module"/*.tf >/dev/null 2>&1 || continue
  found=1
  run_checks "$module"
done
[ "$found" = 1 ] || { echo "no OpenTofu module under infra/" >&2; exit 1; }

# The Lambda unit tests: pure planners and handlers with stubbed clients, offline.
set -- "$root"/infra/*/lambda/*.test.mjs
if [ -e "$1" ]; then
  command -v node >/dev/null 2>&1 || { echo "node is required for the Lambda unit tests" >&2; exit 1; }
  echo "== node --test infra/*/lambda/*.test.mjs"
  node --test "$@"
fi
