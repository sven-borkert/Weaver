#!/usr/bin/env sh
# Builds Weaver's images one after another, smoke-tests them, and pushes the
# requested tags. Runs in GitLab CI (docker:dind) and GitHub Actions; the script test drives it
# with a stub docker. Required: IMAGE COMMIT_SHA SHORT_SHA BUILD_TIME BASE_PATH.
# Optional: PUSH_TAGS (extra tags; empty = build only), DOCKER (command).
set -efu

: "${IMAGE:?}" "${COMMIT_SHA:?}" "${SHORT_SHA:?}" "${BUILD_TIME:?}" "${BASE_PATH:?}"
PUSH_TAGS="${PUSH_TAGS:-}"
DOCKER="${DOCKER:-docker}"

floating=0
for tag in $PUSH_TAGS; do
  case "$tag" in
    latest) floating=1 ;;
    weaver-ci-*) echo "image tags beginning with weaver-ci- are reserved" >&2; exit 1 ;;
  esac
done
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
    --label org.opencontainers.image.created=$BUILD_TIME \
    --label org.weaver.base-path=$BASE_PATH"
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

fail() { echo "$*" >&2; exit 1; }

is_digest() {
  case "$1" in
    sha256:*) digest_hex="${1#sha256:}" ;;
    *) return 1 ;;
  esac
  [ "${#digest_hex}" -eq 64 ] || return 1
  case "$digest_hex" in *[!0123456789abcdef]*) return 1 ;; esac
}

registry_digest() (
  if result="$($DOCKER buildx imagetools inspect --format '{{ printf "%s" .Manifest.Digest }}' "$1" 2>&1)"; then
    is_digest "$result" || fail "invalid digest returned for image: $1"
    printf '%s\n' "$result"
  elif [ "$result" != "ERROR: $1: not found" ]; then
    fail "cannot inspect image $1: $result"
  fi
)

publish_alias() {
  $DOCKER buildx imagetools create --prefer-index=false --tag "$1" "$2"
  [ "$(registry_digest "$1")" = "${2##*@}" ] || fail "image digest did not settle for alias: $1"
}

create_release_manifest() (
  release_dir="$(mktemp -d)"
  trap 'rm -rf "$release_dir"' EXIT
  printf 'FROM scratch\nCOPY release /release\n' > "$release_dir/Dockerfile"
  printf '%s\n' "$2" > "$release_dir/release"
  TZ=UTC touch -t 197001010000.00 "$release_dir/release"
  $DOCKER build --provenance=false --build-arg SOURCE_DATE_EPOCH=0 \
    --label "org.opencontainers.image.revision=$COMMIT_SHA" \
    --label "org.weaver.base-path=$BASE_PATH" \
    --label "org.weaver.release.digests=$2" \
    -t "$1" "$release_dir"
  $DOCKER push "$1"
)

manifest_repo="$IMAGE/tools"
manifest_ref="$manifest_repo:weaver-ci-release-$COMMIT_SHA"
existing_manifest=""
if [ -n "$PUSH_TAGS" ]; then
  existing_manifest="$(registry_digest "$manifest_ref")"
fi

# The Rust stage is not part of the worker runtime image, so it gets its own
# cache image; web's dependency layers are cached through the tools image
# (its builder stage copies the repository and is never pushed), and
# worker/mcp's deps+build stages (also not in their FROM base runtime) each
# get a cache image of their own.
if [ -z "$existing_manifest" ]; then
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
  smoke web 'test -f apps/web/server.js && test -s apps/web/node_modules/mermaid/dist/mermaid.min.js && test -s apps/web/node_modules/katex/dist/katex.min.css && test -s apps/web/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2 && node --import ./apps/web/server-lifecycle.mjs -e "" && '"$launch_chromium"
  smoke worker 'test -x /usr/local/bin/weaver-onenote-reader && test -d packages/db/generated'
  smoke mcp 'test -d packages/db/generated && test -f apps/mcp-server/package.json'
fi

if [ -z "$PUSH_TAGS" ]; then
  echo "PUSH_TAGS is empty: images built and smoke-tested, nothing pushed."
  exit 0
fi

runtime_images="tools web worker mcp"
immutable_tags="$SHORT_SHA"
for tag in $PUSH_TAGS; do
  case " $immutable_tags " in
    *" $tag "*) continue ;;
  esac
  if [ "$tag" != latest ]; then immutable_tags="$immutable_tags $tag"; fi
done

stage_tag="weaver-ci-stage-$COMMIT_SHA"
manifest_digest="$existing_manifest"
if [ -z "$manifest_digest" ]; then
  for name in $runtime_images; do
    for tag in $immutable_tags; do
      ref="$IMAGE/$name:$tag"
      digest="$(registry_digest "$ref")"
      [ -z "$digest" ] || fail "existing immutable image has no matching release manifest: $ref"
    done
  done

  staged=""
  for name in $runtime_images; do
    repo="$IMAGE/$name"
    ref="$repo:$stage_tag"
    digest="$(registry_digest "$ref")"
    if [ -z "$digest" ]; then
      $DOCKER tag "$repo:$SHORT_SHA" "$ref"
      $DOCKER push "$ref"
      digest="$(registry_digest "$ref")"
      [ -n "$digest" ] || fail "staged image is missing: $ref"
    fi
    settings="$($DOCKER buildx imagetools inspect --format '{{index .Image.Config.Labels "org.opencontainers.image.revision"}}|{{index .Image.Config.Labels "org.weaver.base-path"}}' "$repo@$digest")"
    [ "$settings" = "$COMMIT_SHA|$BASE_PATH" ] || fail "staged image does not match this release: $ref"
    staged="$staged $digest"
  done
  create_release_manifest "$manifest_ref" "${staged# }"
  manifest_digest="$(registry_digest "$manifest_ref")"
  [ -n "$manifest_digest" ] || fail "release manifest is missing: $manifest_ref"
fi

manifest_source="$manifest_repo@$manifest_digest"
settings="$($DOCKER buildx imagetools inspect --format '{{index .Image.Config.Labels "org.opencontainers.image.revision"}}|{{index .Image.Config.Labels "org.weaver.base-path"}}|{{index .Image.Config.Labels "org.weaver.release.digests"}}' "$manifest_source")"
case "$settings" in
  "$COMMIT_SHA|$BASE_PATH|"*) release_digests="${settings#"$COMMIT_SHA|$BASE_PATH|"}" ;;
  *) fail "release manifest does not match this commit and base path: $manifest_ref" ;;
esac

# Verify every immutable alias before publishing any of them.
set -- $release_digests
[ "$#" -eq 4 ] || fail "release manifest must specify all four runtime digests: $manifest_ref"
missing_aliases=""
for name in $runtime_images; do
  digest="$1"
  shift
  is_digest "$digest" || fail "release manifest has an invalid $name digest: $manifest_ref"
  source="$IMAGE/$name@$digest"
  [ "$(registry_digest "$source")" = "$digest" ] || fail "release image is missing: $source"
  for tag in $immutable_tags; do
    ref="$IMAGE/$name:$tag"
    actual="$(registry_digest "$ref")"
    if [ -z "$actual" ]; then
      missing_aliases="$missing_aliases $name:$tag=$digest"
    elif [ "$actual" != "$digest" ]; then
      fail "immutable image does not match the release manifest: $ref"
    fi
  done
done

for alias in $missing_aliases; do
  ref="${alias%%=*}"
  publish_alias "$IMAGE/$ref" "$IMAGE/${ref%:*}@${alias#*=}"
done

if [ "$floating" = 1 ]; then
  completed_ref="$manifest_repo:weaver-ci-latest-$COMMIT_SHA"
  completed_digest="$(registry_digest "$completed_ref")"
  if [ -z "$completed_digest" ]; then
    set -- $release_digests
    for name in $runtime_images; do
      publish_alias "$IMAGE/$name:latest" "$IMAGE/$name@$1"
      shift
    done
    publish_alias "$completed_ref" "$manifest_source"
  elif [ "$completed_digest" != "$manifest_digest" ]; then
    fail "latest completion marker does not match the release manifest: $completed_ref"
  fi
fi

# Cache images are build-time inputs only, never run; keep just :latest.
[ "${PUSH_CACHE:-0}" = 1 ] || exit 0
if [ -n "$existing_manifest" ]; then
  build onenote-reader-build docker/worker.Dockerfile notebook-build
  build worker-build docker/worker.Dockerfile build
  build mcp-build docker/mcp.Dockerfile build
fi
for name in onenote-reader-build worker-build mcp-build; do
  $DOCKER tag "$IMAGE/$name:$SHORT_SHA" "$IMAGE/$name:latest"
  $DOCKER push "$IMAGE/$name:latest"
done
