#!/usr/bin/env bash
# Creates the weaver role and the weaver / weaver_test / weaver_e2e databases
# in the local Homebrew PostgreSQL (127.0.0.1:5432). Idempotent — safe to
# re-run. The weaver role password is stored in .local-db-secret (gitignored,
# chmod 600) and must match the DATABASE_URL entries in .env/.env.test/.env.e2e.
set -euo pipefail

PSQL="${WEAVER_PSQL:-$(command -v psql || true)}"
PG_ADMIN_USER="${WEAVER_PG_ADMIN_USER:-$(id -un)}"
SECRET_FILE=".local-db-secret"

if [ ! -x "$PSQL" ]; then
  echo "psql not found at $PSQL. Set WEAVER_PSQL to your psql binary."
  exit 1
fi

# Read (or create) the weaver role password.
if [ -f "$SECRET_FILE" ]; then
  DB_PASSWORD=$(cat "$SECRET_FILE")
  echo "read weaver role password from $SECRET_FILE"
else
  DB_PASSWORD=$(openssl rand -base64 18 | tr '+/' '-_')
  printf '%s' "$DB_PASSWORD" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "created $SECRET_FILE with a fresh weaver role password"
fi

run_sql() {
  "$PSQL" -h 127.0.0.1 -p 5432 -U "$PG_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 -tAc "$1"
}

# Create the weaver role if it does not exist yet.
if [ "$(run_sql "SELECT 1 FROM pg_roles WHERE rolname='weaver'")" = "1" ]; then
  echo "role weaver already exists"
else
  run_sql "CREATE ROLE weaver WITH LOGIN"
  echo "created role weaver"
fi

# psql quotes the environment-derived variable; secrets never appear in argv.
export WEAVER_ROLE_PASSWORD="$DB_PASSWORD"
"$PSQL" -h 127.0.0.1 -p 5432 -U "$PG_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 <<'SQL'
\getenv role_password WEAVER_ROLE_PASSWORD
ALTER ROLE weaver WITH LOGIN PASSWORD :'role_password';
SQL
unset WEAVER_ROLE_PASSWORD

for DB in weaver weaver_test weaver_e2e; do
  EXISTS=$(run_sql "SELECT 1 FROM pg_database WHERE datname='$DB'")
  if [ "$EXISTS" = "1" ]; then
    echo "database $DB already exists"
  else
    run_sql "CREATE DATABASE $DB OWNER weaver"
    echo "created database $DB (owner weaver)"
  fi

  if ! "$PSQL" -h 127.0.0.1 -p 5432 -U "$PG_ADMIN_USER" -d "$DB" -v ON_ERROR_STOP=1 -c \
    "CREATE EXTENSION IF NOT EXISTS vector"; then
    echo "failed to enable pgvector in database $DB; install the pgvector extension files for the PostgreSQL server and rerun this script."
    exit 1
  fi
done
