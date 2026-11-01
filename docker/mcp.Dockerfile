# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_HOME=/usr/local/share/corepack
RUN apk add --no-cache git libc6-compat openssl tini && corepack enable

FROM base AS deps
# Placeholder URL satisfies prisma generate at build time; never used at runtime.
ENV BUILD_ONLY_DATABASE_URL=postgresql://weaver:build-only@localhost:5432/weaver?schema=public
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/agent-worker/package.json apps/agent-worker/package.json
COPY apps/mcp-server/package.json apps/mcp-server/package.json
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
COPY tsconfig.base.json ./
COPY packages/db packages/db
RUN DATABASE_URL=$BUILD_ONLY_DATABASE_URL pnpm db:generate

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/agent-worker/package.json apps/agent-worker/package.json
COPY apps/mcp-server/package.json apps/mcp-server/package.json
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
COPY --chown=node:node apps/mcp-server apps/mcp-server
COPY --chown=node:node packages packages
COPY --chown=node:node tsconfig.base.json ./
COPY --from=build --chown=node:node /app/packages/db/generated packages/db/generated
USER node
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEAVER_MCP_PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "-g", "--"]
CMD ["pnpm", "--dir", "apps/mcp-server", "start"]
