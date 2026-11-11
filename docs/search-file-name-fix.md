# Keyword search: file names inside paths

This note records a search fix (commit `ef9e8e3`, "fix(search): make file names
inside paths findable by keyword") so it can be reproduced and verified on another
checkout or deployment.

## Symptom

A document whose body contains absolute paths, for example

```
- `/app/sword/axway/Interchange/conf/datastoreconfig.xml`
```

could not be found by searching for the bare file name `datastoreconfig.xml`.
Searching for the full path also failed on older builds. The document was
indexed (`DocumentIndexState.status = 'ready'`), so the problem was in the
query and tokenization, not in indexing.

## Root cause

Keyword search uses PostgreSQL `to_tsvector('simple', ...)` on
`DocumentSearchChunk` and `websearch_to_tsquery('simple', ...)` on the query.
The default parser classifies `/app/.../datastoreconfig.xml` as a single
"file" token and stores it as one lexeme. The bare name `datastoreconfig.xml`
is only indexed when it appears on its own, so the lexeme never matches.

Reproduce in any `psql` session:

```sql
SELECT to_tsvector('simple', '/app/sword/axway/Interchange/conf/datastoreconfig.xml');
-- '/app/sword/axway/interchange/conf/datastoreconfig.xml':1

SELECT to_tsvector('simple', 'see datastoreconfig.xml and');
-- 'and':3 'datastoreconfig.xml':2 'see':1

SELECT websearch_to_tsquery('simple', 'datastoreconfig.xml');
-- 'datastoreconfig.xml'
```

## The change

1. Migration `packages/db/prisma/migrations/20261104090000_document_search_path_tokens/migration.sql`:
   - adds `weaver_search_text(text)`, an immutable function that replaces `/`, `\`, `.`
     and `_` with spaces (`regexp_replace(input, '[/\\._]', ' ', 'g')`);
   - drops and re-adds `DocumentSearchChunk.searchVector` as
     `to_tsvector('simple', weaver_search_text(heading path || content))`;
   - recreates the GIN index `DocumentSearchChunk_searchVector_idx`.
2. `packages/core/src/services/searchLexical.ts`: the chunk query now uses
   `websearch_to_tsquery('simple', weaver_search_text($query))`, so both sides
   tokenize the same way. Hyphens are left alone so `-word` exclusion still works.
3. `apps/web/tests/integration/knowledgeIndex.spec.ts`: new test
   "finds a document by a file name that appears inside a path in its body". It
   queries `datastoreconfig.xml`, `datastoreconfig`, the full path and `tnsnames.ora`.
4. `docs/IMPLEMENTATION.md`: the keyword-index design note describes the normalization.

Existing rows need no reindex: PostgreSQL recomputes a generated column when the
migration rebuilds it.

Reproduce the query-side effect after the migration:

```sql
SELECT count(*) FROM "DocumentSearchChunk"
WHERE "searchVector" @@ websearch_to_tsquery('simple', weaver_search_text('datastoreconfig.xml'));
```

## Reproduce locally

Requires Node/pnpm as in `docs/setup.md` and a PostgreSQL 17 server with pgvector.
The test run uses its own database (`weaver_test`) and env file, which the
harness truncates, so do not point it at a database you care about.

```bash
# 1. Throwaway database
docker run -d --name weaver-knowledge-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=<password> \
  -p 127.0.0.1:55432:5432 pgvector/pgvector:0.8.6-pg17-trixie
docker exec weaver-knowledge-test-pg psql -U postgres -c 'CREATE DATABASE weaver_test;'

# 2. .env.test (gitignored): copy .env.example, then set
#    DATABASE_URL="postgresql://postgres:<password>@127.0.0.1:55432/weaver_test"
#    WEAVER_DATA_DIR="./data-test"
#    WEAVER_ENCRYPTION_KEYS="1:$(openssl rand -base64 32)"
#    AUTH_SECRET="$(openssl rand -base64 32)"

# 3. Migrate, then run the knowledge integration suites
pnpm install
pnpm db:test:migrate
pnpm test:integration:knowledge
```

Expected: 14 files and 285 tests pass, including the new path test. Then run
`pnpm typecheck` and the unit tests (`pnpm --filter @weaver/core test`,
`pnpm --filter @weaver/web test`).

## Deploy on b2bisecdep1

The host builds images from `origin/main`; it does not pull from a registry.
Run from a session with agent forwarding (`ssh -A`):

```bash
sudo /usr/local/sbin/weaver-upgrade ef9e8e3893aeb59027b32b92f474e6e55be3f883
```

The script builds, smoke-tests, backs up (the application is stopped during the
backup), deploys, and waits for health. On success it prints
`upgraded to 0.1.241 (ef9e8e38…)`.

Verify:

```bash
curl -fsSk --noproxy '*' -H 'Host: b2bisecdep1.carveout-np.aws.signintra.com:8443' \
  https://127.0.0.1:8443/weaver/api/health
# commitSha should be ef9e8e3893aeb59027b32b92f474e6e55be3f883
```

Then confirm the newest row in `_prisma_migrations` is
`20261104090000_document_search_path_tokens` and that the query above returns a
non-zero count.

## Known limits

- Hyphenated names such as `hibernate-conn.properties` keep the default parser
  behavior for the hyphen; only `/`, `.`, `\` and `_` are normalized.
- The migration drops and recreates `DocumentSearchChunk.searchVector`, so it
  rewrites that table's generated column during deploy. The deploy takes a backup
  first.
- The `github` mirror (`sven-borkert/Weaver`) has a different history and does not
  contain this commit.
