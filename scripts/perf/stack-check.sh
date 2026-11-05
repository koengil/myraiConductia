# Sourced by with-local-stack.sh and rail-stack.sh (#162): confirms that docker
# is the LOCAL daemon and that the running containers are the throwaway stack,
# before anything writes to it. Requires HERE (the scripts/perf directory).

# Docker must be this host's daemon through the default context: a DOCKER_HOST,
# a DOCKER_CONTEXT other than default, or a non-default current context in the
# docker config could point every docker and supabase call at another machine.
require_local_docker() {
  if [[ -n "${DOCKER_HOST+x}" ]]; then
    echo "stack-check: DOCKER_HOST is set; only the local docker daemon (default context) is allowed" >&2
    return 1
  fi
  if [[ -n "${DOCKER_CONTEXT+x}" && "$DOCKER_CONTEXT" != "default" ]]; then
    echo "stack-check: DOCKER_CONTEXT is not default; only the local docker daemon (default context) is allowed" >&2
    return 1
  fi
  local pass=(PATH="$PATH" HOME="${HOME:-/}") context
  [[ -n "${DOCKER_CONFIG+x}" ]] && pass+=(DOCKER_CONFIG="$DOCKER_CONFIG")
  if ! context="$(env -i "${pass[@]}" docker context show 2>/dev/null)"; then
    echo "stack-check: docker context show failed, so the local daemon cannot be confirmed" >&2
    return 1
  fi
  if [[ "$context" != "default" ]]; then
    echo "stack-check: the current docker context is not default; only the local docker daemon is allowed" >&2
    return 1
  fi
}

# The running service must be this stack: one `docker ps`, parsed by
# localStack.mjs's assertRunningStack (via stack-identity.mjs).
require_running_stack() {
  require_local_docker || return 1
  local pass=(PATH="$PATH" HOME="${HOME:-/}") listing
  [[ -n "${DOCKER_CONFIG+x}" ]] && pass+=(DOCKER_CONFIG="$DOCKER_CONFIG")
  if ! listing="$(env -i "${pass[@]}" docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null)"; then
    echo "stack-check: docker ps failed, so the running stack cannot be confirmed; refusing a write" >&2
    return 1
  fi
  printf '%s\n' "$listing" | env -i PATH="$PATH" node "$HERE/stack-identity.mjs" running
}
