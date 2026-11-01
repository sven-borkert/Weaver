#!/usr/bin/env sh
# Builds Weaver's images one after another, smoke-tests them, and pushes the
# requested tags. Runs in GitLab CI (docker:dind) and GitHub Actions; the script test drives it
# with a stub docker. Required: IMAGE COMMIT_SHA SHORT_SHA BUILD_TIME BASE_PATH.
# Optional: PUSH_TAGS (extra tags; empty = build only), DOCKER (command).
set -eu

: "${IMAGE:?}" "${COMMIT_SHA:?}" "${SHORT_SHA:?}" "${BUILD_TIME:?}" "${BASE_PATH:?}"
PUSH_TAGS="${PUSH_TAGS:-}"
DOCKER="${DOCKER:-docker}"

floating=0
for tag in $PUSH_TAGS; do [ "$tag" != latest ] || floating=1; done
if [ "$floating" = 1 ] || [ "${PUSH_CACHE:-0}" = 1 ]; then
  if [ -n "${CI_COMMIT_TAG:-}" ] || [ -z "${CI_DEFAULT_BRANCH:-}" ] || [ "${CI_COMMIT_BRANCH:-}" != "$CI_DEFAULT_BRANCH" ]; then
    echo "only default-branch pipelines may publish floating aliases" >&2
    exit 1
  fi
fi

# Provenance attestations record the Git remote of the build; nothing reads them.
common_args() {
  echo "--provenance=false \
    --build-arg BUILDKIT_INLINE_CACHE=1 \
    --build-arg NEXT_PUBLIC_BASE_PATH=$BASE_PATH \
    --build-arg APP_COMMIT_SHA=$COMMIT_SHA \
    --build-arg APP_BUILD_TIME=$BUILD_TIME \
    --label org.opencontainers.image.revision=$COMMIT_SHA \
    --label org.opencontainers.image.created=$BUILD_TIME"
}

# build <name> <dockerfile> <target> [extra cache images...]
build() {
  name="$1"; dockerfile="$2"; target="$3"; shift 3
  cache="--cache-from $IMAGE/$name:latest"
  for extra in "$@"; do cache="$cache --cache-from $IMAGE/$extra:latest"; done
  # shellcheck disable=SC2046
  $DOCKER build --pull -f "$dockerfile" --target "$target" $cache $(common_args) \
    -t "$IMAGE/$name:$SHORT_SHA" .
}

# Agent instructions, internal docs and deploy files must never reach a published image.
no_internal='for p in .git .claude .codex .superpowers CLAUDE.md AGENTS.md docs deploy; do if [ -e "$p" ]; then echo "internal path in image: $p" >&2; exit 1; fi; done'

smoke() {
  $DOCKER run --rm --entrypoint sh "$IMAGE/$1:$SHORT_SHA" -c "$no_internal; $2"
}

# The Rust stage is not part of the worker runtime image, so it gets its own
# cache image; web's dependency layers are cached through the tools image
# (its builder stage copies the repository and is never pushed), and
# worker/mcp's deps+build stages (also not in their FROM base runtime) each
# get a cache image of their own.
build onenote-reader-build docker/worker.Dockerfile notebook-build
build tools docker/web.Dockerfile tools
build web docker/web.Dockerfile runtime tools
build worker-build docker/worker.Dockerfile build
build worker docker/worker.Dockerfile runtime onenote-reader-build worker-build
build mcp-build docker/mcp.Dockerfile build
build mcp docker/mcp.Dockerfile runtime mcp-build

# The Prisma config resolves DATABASE_URL at load time even though
# `prisma --version` never connects; the tools image has no runtime value.
smoke tools 'DATABASE_URL=postgresql://weaver:smoke@localhost:5432/weaver?schema=public pnpm --filter @weaver/db exec prisma --version'
# playwright-core reads browsers.json when it loads; a trace that drops it disables PDF export.
launch_chromium='node -e "require(process.argv[1]).chromium.launch({executablePath:process.env.WEAVER_CHROMIUM_PATH,args:process.argv.slice(2)}).then((browser)=>browser.close())"'
launch_chromium="$launch_chromium"' -- "$PWD"/apps/web/.next/node_modules/playwright-core-* --no-sandbox --disable-setuid-sandbox'
# The PDF export reads the Mermaid bundle from the app directory at runtime.
smoke web 'test -f apps/web/server.js && test -s apps/web/node_modules/mermaid/dist/mermaid.min.js && node --import ./apps/web/server-lifecycle.mjs -e "" && '"$launch_chromium"
smoke worker 'test -x /usr/local/bin/weaver-onenote-reader && test -d packages/db/generated'
smoke mcp 'test -d packages/db/generated && test -f apps/mcp-server/package.json'

if [ -z "$PUSH_TAGS" ]; then
  echo "PUSH_TAGS is empty: images built and smoke-tested, nothing pushed."
  exit 0
fi

# Check every immutable alias before publishing any part of the release.
for name in tools web worker mcp; do
  for tag in $PUSH_TAGS; do
    [ "$tag" = latest ] && continue
    if output="$($DOCKER manifest inspect "$IMAGE/$name:$tag" 2>&1)"; then
      echo "refusing to overwrite existing image: $IMAGE/$name:$tag" >&2
      exit 1
    elif ! printf '%s' "$output" | grep -Eqi 'manifest unknown|no such manifest|not found'; then
      echo "cannot verify availability of image tag: $IMAGE/$name:$tag" >&2
      exit 1
    fi
  done
done

for name in tools web worker mcp; do
  $DOCKER push "$IMAGE/$name:$SHORT_SHA"
  for tag in $PUSH_TAGS; do
    $DOCKER tag "$IMAGE/$name:$SHORT_SHA" "$IMAGE/$name:$tag"
    $DOCKER push "$IMAGE/$name:$tag"
  done
done

# Cache images are build-time inputs only, never run; keep just :latest.
[ "${PUSH_CACHE:-0}" = 1 ] || exit 0
for name in onenote-reader-build worker-build mcp-build; do
  $DOCKER tag "$IMAGE/$name:$SHORT_SHA" "$IMAGE/$name:latest"
  $DOCKER push "$IMAGE/$name:latest"
done
