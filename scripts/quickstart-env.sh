#!/usr/bin/env sh
# Writes .env.quickstart with fresh secrets for docker-compose.quickstart.yml.
# Keeps an existing file: its secrets belong to the data already in the volumes.
set -eu

cd "$(dirname "$0")/.."
ENV_FILE=.env.quickstart

if [ -e "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists; keeping it."
  exit 0
fi

umask 077
cat > "$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -base64 32)
WEAVER_ENCRYPTION_KEYS=1:$(openssl rand -base64 32)
WEAVER_BOOTSTRAP_ADMIN_EMAIL=${WEAVER_BOOTSTRAP_ADMIN_EMAIL:-admin@example.com}
WEAVER_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 16)
WEAVER_WEB_PORT=${WEAVER_WEB_PORT:-3000}
WEAVER_MCP_PORT=${WEAVER_MCP_PORT:-3200}
# Private-range LLM, Docling and MCP origins, comma separated (exact origins, no paths).
WEAVER_OUTBOUND_ALLOWED_ORIGINS=
ENV

echo "Wrote $ENV_FILE. The first Admin's sign-in is in WEAVER_BOOTSTRAP_ADMIN_EMAIL and WEAVER_BOOTSTRAP_ADMIN_PASSWORD."
