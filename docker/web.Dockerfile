# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_HOME=/usr/local/share/corepack
RUN apk add --no-cache libc6-compat openssl

FROM base AS deps
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/agent-worker/package.json apps/agent-worker/package.json
COPY apps/mcp-server/package.json apps/mcp-server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/artifact-readers/package.json packages/artifact-readers/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/assistant-tools/package.json packages/assistant-tools/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/external-mcp/package.json packages/external-mcp/package.json
COPY packages/git-store/package.json packages/git-store/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN corepack install && chmod -R a+rX "$COREPACK_HOME" && pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS workspace
# Placeholder URL satisfies prisma generate and next build; never used at runtime.
ENV BUILD_ONLY_DATABASE_URL=postgresql://weaver:build-only@localhost:5432/weaver?schema=public
COPY tsconfig.base.json ./
COPY packages packages
RUN DATABASE_URL=$BUILD_ONLY_DATABASE_URL pnpm db:generate

# Published image: workspace packages only, never the stage that copies the whole repository.
FROM workspace AS tools
USER node
CMD ["pnpm", "--filter", "@weaver/db", "migrate:deploy"]

FROM workspace AS builder
COPY . .
ARG NEXT_PUBLIC_BASE_PATH=/weaver
ARG APP_BUILD_TIME=""
ARG APP_COMMIT_SHA=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
ENV APP_BUILD_TIME=$APP_BUILD_TIME
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
# Opt into Next's standalone output — the runtime stage copies .next/standalone.
RUN SKIP_ENV_VALIDATION=1 BUILD_STANDALONE=1 DATABASE_URL=$BUILD_ONLY_DATABASE_URL \
  AUTH_SECRET=build-only-auth-secret-not-used-at-runtime AUTH_URL=https://build.invalid WEAVER_DATA_DIR=/data \
  pnpm --filter @weaver/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Chromium renders document PDF exports (playwright-core drives the distro build).
RUN apk add --no-cache git openssh-client tini chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV WEAVER_CHROMIUM_PATH=/usr/bin/chromium
ENV WEAVER_CHROMIUM_NO_SANDBOX=true
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=node:node /app/apps/web/server-lifecycle.mjs ./apps/web/server-lifecycle.mjs
USER node
EXPOSE 3000
# Liveness probe — hit /api/health under the configured base path (Node 22 has global fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.NEXT_PUBLIC_BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "-g", "--"]
CMD ["node", "--import", "./apps/web/server-lifecycle.mjs", "apps/web/server.js"]
