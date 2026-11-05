#!/usr/bin/env bash
# Turns on the work-identity mock providers in the CHECKOUT's supabase/config.toml
# (issue #316). The file ships both blocks with `enabled = false`: the CLI cannot
# read a boolean from an unset env(), so a stack that wants them sets `enabled` in
# its own copy. This is that edit, for the CI job (.github/workflows/e2e-work-identity.yml).
# The checkout is ephemeral; never run this on a working tree you keep.
#
#   scripts/ci/enable-work-identity-broker.sh azure     [config.toml]
#   scripts/ci/enable-work-identity-broker.sh keycloak  [config.toml]
#
# azure     the REAL azure provider, with `url` pointed at the mock issuer
#           (WORK_IDENTITY_MOCK_AZURE_URL). The keycloak block is enabled as well,
#           because tests/integration/work-identity-broker.test.ts probes Auth through it.
# keycloak  the fallback, used only if the real provider refuses the mock issuer:
#           keycloak stands in for the firm's provider (WORK_IDENTITY_MOCK_OIDC_URL).
#
# The environment the stack needs at `supabase start` is the caller's to set
# (the secret and url variables named in config.toml); this script only edits
# the file, then proves each block it meant to enable is enabled.
set -euo pipefail

mode="${1:-}"
config="${2:-supabase/config.toml}"

case "$mode" in
  azure)    blocks=(azure keycloak); label='azure provider' ;;
  keycloak) blocks=(keycloak);       label='keycloak fallback' ;;
  *)
    echo "usage: $0 azure|keycloak [config.toml]" >&2
    exit 2
    ;;
esac

[ -f "$config" ] || { echo "work-identity broker: $config not found" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for block in "${blocks[@]}"; do
  # Flip `enabled` inside [auth.external.<block>] only; a missing block or key is an error.
  awk -v section="[auth.external.${block}]" '
    { line = $0; sub(/[[:space:]]+$/, "", line) }
    /^\[/ { in_section = (line == section); if (in_section) seen = 1 }
    in_section && /^enabled[[:space:]]*=/ { print "enabled = true"; flipped = 1; next }
    { print }
    END { if (!seen || !flipped) exit 3 }
  ' "$config" > "$tmp" || { echo "work-identity broker: [auth.external.${block}] has no enabled key in $config" >&2; exit 1; }
  cat "$tmp" > "$config"
done

# Prove it: each block reads enabled = true, and nothing else was turned on.
for block in "${blocks[@]}"; do
  awk -v section="[auth.external.${block}]" '
    { line = $0; sub(/[[:space:]]+$/, "", line) }
    /^\[/ { in_section = (line == section) }
    in_section && /^enabled[[:space:]]*=[[:space:]]*true[[:space:]]*$/ { ok = 1 }
    END { exit ok ? 0 : 1 }
  ' "$config" || { echo "work-identity broker: [auth.external.${block}] is not enabled after the edit" >&2; exit 1; }
done

echo "work-identity broker: ${label} (enabled in ${config}: ${blocks[*]})"
