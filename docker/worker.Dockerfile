# syntax=docker/dockerfile:1.7

FROM rust:1.98.1-alpine AS notebook-build
RUN apk add --no-cache musl-dev
WORKDIR /reader
COPY packages/ingestion/native/onenote-reader/ ./
RUN cargo build --release --locked

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_HOME=/usr/local/share/corepack
RUN apk add --no-cache git openssh-client libc6-compat openssl tini && corepack enable

FROM base AS deps
# Placeholder URL satisfies prisma generate at build time; never used at runtime.
ENV BUILD_ONLY_DATABASE_URL=postgresql://weaver:build-only@localhost:5432/weaver?schema=public
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/agent-worker/package.json apps/agent-worker/package.json
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

FROM deps AS build
# Prisma generate depends only on packages/db (plus the shared tsconfig); copy
# them first so edits to the other packages do not invalidate this layer.
COPY tsconfig.base.json ./
COPY packages/db packages/db
RUN DATABASE_URL=$BUILD_ONLY_DATABASE_URL pnpm db:generate

FROM base AS runtime
ENV NODE_ENV=production
ENV WEAVER_ONENOTE_READER_PATH=/usr/local/bin/weaver-onenote-reader
COPY --from=notebook-build /reader/target/release/weaver-onenote-reader /usr/local/bin/weaver-onenote-reader
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/agent-worker/package.json apps/agent-worker/package.json
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
RUN corepack install && chmod -R a+rX "$COREPACK_HOME" && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node apps/agent-worker apps/agent-worker
COPY --chown=node:node packages packages
COPY --chown=node:node tsconfig.base.json ./
COPY --from=build --chown=node:node /app/packages/db/generated packages/db/generated
USER node
EXPOSE 3101 3102
ENTRYPOINT ["tini", "-g", "--"]
CMD ["pnpm", "--dir", "apps/agent-worker", "start"]
