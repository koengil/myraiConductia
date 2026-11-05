#!/usr/bin/env bash
# Launch the onboarding agent-duo run (Orca orchestration mode).
# Claude = planner/coordinator, Codex = reviewer/worker. One shared worktree.
#
#   ./launch.sh                 # reuse the ACTIVE worktree's agent terminals
#   ./launch.sh --new-worktree  # create duo-onboarding (codex first, split claude)
#   ./launch.sh --no-reset      # keep the worktree's current branch
#
# Prompts are canonical in this folder (planner.txt / reviewer.txt with
# {{HANDLE}} placeholders); this script resolves runtime terminal handles,
# writes *.resolved.txt into the worktree's run folder, and sends reviewer-first.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAIN_CHECKOUT="/Users/martincasado/FutureProofing/intellibank"
RUN_ID="onboarding"
RUNS_ROOT="docs/agent-duo/runs"
BASE_BRANCH="develop"
NEW_WORKTREE=0
RESET_BRANCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new-worktree) NEW_WORKTREE=1; shift ;;
    --no-reset)     RESET_BRANCH=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }
orca status --json >/dev/null 2>&1 || { echo "Orca unreachable. Run: orca open --json" >&2; exit 1; }

if [[ $NEW_WORKTREE -eq 1 ]]; then
  orca worktree create --name "duo-${RUN_ID}" --agent codex --json >/dev/null
  sleep 2
  FIRST=$(orca terminal list --worktree active --json | jq -r '.result.terminals[0].handle')
  orca terminal wait --terminal "$FIRST" --for tui-idle --timeout-ms 180000 --json >/dev/null
  orca terminal split --terminal "$FIRST" --direction horizontal --command claude --json >/dev/null
  sleep 2
fi

TERMS=$(orca terminal list --worktree active --json)
WT_PATH=$(jq -r '.result.terminals[0].worktreePath' <<<"$TERMS")

REV=$(jq -r '.result.terminals[] | select((.preview // .title // "") | ascii_downcase | contains("codex")) | .handle' <<<"$TERMS" | head -1)
PLN=$(jq -r '.result.terminals[] | select((.preview // .title // "") | ascii_downcase | contains("claude")) | .handle' <<<"$TERMS" | head -1)
[[ -n "$REV" && -n "$PLN" && "$REV" != "$PLN" ]] || {
  echo "Could not resolve distinct codex (reviewer) and claude (planner) terminals in the active worktree:" >&2
  jq -r '.result.terminals[] | "  \(.handle)  \(.title)  \(.preview // "")"' <<<"$TERMS" >&2
  exit 1
}

RUN_DIR="${WT_PATH}/${RUNS_ROOT}/${RUN_ID}"
mkdir -p "$RUN_DIR"

# A worktree carries the branch it was created on; without a reset a new run
# stacks on the previous run's feature branch and the PR inherits it.
if [[ $RESET_BRANCH -eq 1 ]]; then
  git -C "$WT_PATH" fetch origin "$BASE_BRANCH"
  git -C "$WT_PATH" checkout -B "duo/${RUN_ID}" "origin/${BASE_BRANCH}"
fi

# Worktrees don't inherit untracked env; the planner needs the Resend/Box keys.
[[ -f "$MAIN_CHECKOUT/.env.local" && ! -f "$WT_PATH/.env.local" ]] && cp "$MAIN_CHECKOUT/.env.local" "$WT_PATH/.env.local"

sed -e "s/{{REVIEWER_HANDLE}}/$REV/g" -e "s/{{PLANNER_HANDLE}}/$PLN/g" "$HERE/planner.txt"  > "$RUN_DIR/planner.resolved.txt"
sed -e "s/{{REVIEWER_HANDLE}}/$REV/g" -e "s/{{PLANNER_HANDLE}}/$PLN/g" "$HERE/reviewer.txt" > "$RUN_DIR/reviewer.resolved.txt"

# Reviewer first: it must be listening before any artifact lands.
orca terminal send --terminal "$REV" --text "$(cat "$RUN_DIR/reviewer.resolved.txt")" --enter --json >/dev/null
orca terminal wait --terminal "$REV" --for tui-idle --timeout-ms 180000 --json >/dev/null
orca terminal send --terminal "$PLN" --text "$(cat "$RUN_DIR/planner.resolved.txt")" --enter --json >/dev/null

echo "duo run '${RUN_ID}' launched in ${WT_PATH}"
echo "  reviewer (codex):  $REV"
echo "  planner  (claude): $PLN"
echo "watch: orca orchestration task-list --json | jq '.result.tasks[] | select(.task_title | contains(\"run ${RUN_ID}\"))'"
