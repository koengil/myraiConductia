# syntax=docker/dockerfile:1
#
# The deal-discovery worker (design Q1, Q17): one image, its entrypoints
# dispatched by worker/entrypoint.sh.
#
#   docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" -f worker/Dockerfile -t conductia-discovery-worker .
#   docker run --env-file <worker env> conductia-discovery-worker classify
#   docker run --env-file <worker env> conductia-discovery-worker extract   # phase 6
#   docker run --env-file <worker env> conductia-discovery-worker probe --live --confirm-domain <domain> \
#     --tenant <tenant id> --allow-remote-db --out /tmp/probe              # #344, design R15
#   docker run --read-only --mount type=volume,dst=/tmp conductia-discovery-worker self-check
#
# The worker is bundled with esbuild into one ESM file per entrypoint, so the
# runtime image carries no dev tooling and none of the web app's packages.
# unpdf stays outside the bundle: the sandboxed extractor child
# (src/lib/graph/reader/extract/child.mjs) loads it by path under Node's
# permission model. No secret or .env file enters the image (.dockerignore);
# the environment is supplied at run time (scripts/m365/README.md step 5).
#
# Provenance (#344, design R3): GIT_SHA is the commit the build context was
# checked out at, read with git rev-parse from a clean worktree, never typed. A
# value that is not 40 lowercase hex is refused before anything is built, and the
# image carries it as org.opencontainers.image.revision, which go-live gates G1
# and G2 check against the #331 and #338 merges.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS revision
ARG GIT_SHA=""
# The length test and the character test together refuse a branch name, a short
# sha, uppercase hex and an embedded newline.
RUN if [ "${#GIT_SHA}" -ne 40 ] || [ -n "$(printf '%s' "$GIT_SHA" | tr -d '0-9a-f')" ]; then \
      echo "GIT_SHA must be the full 40-character lowercase commit sha: --build-arg GIT_SHA=\"\$(git rev-parse HEAD)\"" >&2; \
      exit 1; \
    fi; \
    printf '%s\n' "$GIT_SHA" > /revision

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker
# The connection probe (#344, design R15) runs from the task, so its source is in
# the build context (.dockerignore allows scripts/google only). Only the bundle
# reaches the runtime stage; no script source does.
COPY scripts/google ./scripts/google
# name=source pairs: each entry is bundled only when its source exists (extract
# arrives with the milestone extractor).
RUN set -e; for pair in classify=worker/classify.ts extract=worker/extract.ts probe=scripts/google/probe-connections.ts; do \
      entry="${pair%%=*}"; path="${pair#*=}"; \
      if [ -f "$path" ]; then \
        npx --no-install esbuild "$path" --bundle --platform=node --format=esm --target=node22 \
          --external:unpdf --external:pg-native --log-level=warning \
          --banner:js="import { createRequire as __workerRequire } from 'node:module'; const require = __workerRequire(import.meta.url);" \
          --outfile="dist/worker/$entry.mjs"; \
      fi; \
    done

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules/unpdf ./node_modules/unpdf
COPY --from=build /app/dist/worker ./dist/worker
COPY src/lib/graph/reader/extract/child.mjs ./src/lib/graph/reader/extract/child.mjs
COPY worker/entrypoint.sh ./worker/entrypoint.sh
# Copied so the runtime stage depends on the checked revision stage: an image
# with an unchecked or missing revision cannot be produced.
COPY --from=revision /revision ./REVISION
RUN printf '{"name":"conductia-discovery-worker","private":true}\n' > package.json \
 && chmod 0555 worker/entrypoint.sh
# The root filesystem is read-only on ECS (#344, design R6); /tmp is the one
# writable path. The entrypoint writes the two workload identity configs to
# /tmp/google, so the directory belongs to node, mode 0700. VOLUME comes after
# it: Fargate and Docker seed a fresh volume from the image's directory,
# ownership included, so node can write it under a read-only root.
RUN mkdir -p /tmp/google && chown node:node /tmp/google && chmod 0700 /tmp/google
VOLUME /tmp
ARG GIT_SHA=""
LABEL org.opencontainers.image.revision=$GIT_SHA
USER node
ENTRYPOINT ["/app/worker/entrypoint.sh"]
CMD ["classify"]
