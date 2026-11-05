#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json ignoreCommand). Vercel's contract:
# exit 0 skips the deployment, exit 1 builds it.
#
# Preview builds were spent on pushes nobody opens: agent sessions push every
# fix round, and stacked slices or docs-only changes rarely need a preview. So:
#   1. `[preview]` in the commit message always builds (the manual trigger).
#   2. develop, staging and main always build.
#   3. Pushes by the owner's agent account (VERCEL_SKIP_AUTHORS, default gui9k)
#      are skipped.
#   4. Stacked slices are skipped: branches named <type>/<issue>-<n>-... with
#      n >= 2 (Vercel cannot see the PR base, so this is a naming heuristic; a
#      wrong guess costs one preview or one `[preview]` push).
#   5. Docs-only changes are skipped, using CI's path rule (scripts/ci/docs-paths.mjs)
#      on the range since the last deployed commit. A range outside the shallow
#      clone, or unknown, builds.
# A Vercel CLI or dashboard redeploy does not go through this step.
set -uo pipefail

ref=${VERCEL_GIT_COMMIT_REF:-}
msg=${VERCEL_GIT_COMMIT_MESSAGE:-}
author=${VERCEL_GIT_COMMIT_AUTHOR_LOGIN:-}
skip_authors=${VERCEL_SKIP_AUTHORS:-gui9k}

build() { echo "vercel-ignore: build ($1)"; exit 1; }
skip() { echo "vercel-ignore: skip ($1); push with [preview] in the message to build"; exit 0; }

case "$msg" in *"[preview]"*) build "[preview] requested" ;; esac
case "$ref" in develop | staging | main) build "integration branch $ref" ;; esac

for a in ${skip_authors//,/ }; do
	[ -n "$author" ] && [ "$author" = "$a" ] && skip "author $author"
done

if [[ "$ref" =~ ^[a-z]+/[0-9]+-([2-9]|[1-9][0-9]+)- ]]; then
	skip "stacked slice $ref"
fi

# Vercel clones about 10 commits deep, so CI's detector (which refuses shallow
# clones) can't be reused as is. Diff against the last deployed commit only when
# it is inside the clone and an ancestor of this one; otherwise build.
base=${VERCEL_GIT_PREVIOUS_SHA:-}
head=${VERCEL_GIT_COMMIT_SHA:-HEAD}
if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null &&
	git merge-base --is-ancestor "$base" "$head" 2>/dev/null; then
	if git diff --name-only --no-renames -z "$base" "$head" -- |
		node --input-type=module -e "
			import { readFileSync } from 'node:fs';
			import { isDocumentation } from './scripts/ci/docs-paths.mjs';
			const files = readFileSync(0, 'utf8').split('\\0').filter(Boolean);
			process.exit(files.length > 0 && files.every(isDocumentation) ? 0 : 1);
		"; then
		skip "documentation-only change"
	fi
fi

build "default"
