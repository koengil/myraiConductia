# supabase/: how schema changes ship

Schema changes follow one path: a migration file here, merged through a PR, applied by the **Migrate database** Action, which records each file in the database's ledger. Your change ends at the merged PR. That path keeps dev, staging and production identical, so SQL reaches hosted databases only through it (the SQL editor, MCP and direct connections bypass the ledger).

## A migration PR contains

- [ ] **A new file** `migrations/YYYYMMDDHHMMSS_name.sql`, timestamped after the newest migration on your base branch. Files already on `main` stay byte-for-byte as they are; a change goes in a new file. A file on `develop` but not yet on `main` is edited only to repair one that failed on a hosted database.
- [ ] **A green `npm run check:migrations`:** prefixes, order, restated `CHECK` lists (a deliberate value removal carries `-- check-removes: <values> <reason>`) and a lint of your new files. Write to the lint from the start: definers set `search_path = public, pg_temp` and revoke execute from `public, anon, authenticated`; browser table grants are listed in `lint/browser-grants.txt`; catalog loops touch only our objects; on `lint/big-tables.txt` tables, indexes are `create index concurrently` alone in their own file and constraints go `not valid` with `validate` in a later file. A deliberate exception carries `-- lint-allow: <rule> <reason>`.
- [ ] **An updated `schema-snapshot.txt`**, generated from a freshly reset local stack. CI rebuilds it the same way and compares:
  ```sh
  supabase db reset --local
  echo 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres' > .env.snapshot.local
  npm run schema:snapshot -- .env.snapshot.local
  ```
  Use this file, not `.env.local` (that is Conductia-dev). Exported shell variables win over `--env-file`, so run it with no hosted `DATABASE_URL` in the environment.
- [ ] **Enum mirrors:** each new `CHECK` value also in its TypeScript constant (`src/lib/constants/*`); the SQL is the source of truth.
- [ ] **Wired probes:** a new SQL probe in `tests/` runs in CI (the probe step in `ci.yml`, or a `tests/db/*.test.ts` wrapper listed there). Before pushing, run the wrappers for the tables you touched: `RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run tests/db/<name>.test.ts` (without both variables they skip); CI runs the full list in `ci.yml`, since new constraints break other features' fixtures.
- [ ] **A `Hosted counts:` line in the PR body** when the migration adds a unique index, `NOT NULL` or a validated constraint, or changes rows: the read-only query and its result on dev, staging and production.

## Design rules the linter can't see

- A state change and its audit row are written in one security-definer function.
- Code works against both the old and the new schema: the app can deploy before its migration lands.

## After merge

| Database | Applied by | You |
|---|---|---|
| Dev (also read by previews and PR branches) | The merge to `develop`, within about a minute | Confirm the **Migrate database** run is green |
| Staging (its own database) | **Promote develop to staging** | Nothing: it migrates staging before moving the branch |
| Production | **Promote staging to main**, run by an approver in `MIGRATION_APPROVERS`; it also tags `vX.Y.Z` and publishes release notes | Nothing |

Environment setup: `docs/04-operations/production-bootstrap.md`.

## Undoing a change

Revert the PR but keep its migration file (the ledger has it): `git revert -n <sha>`, `git checkout HEAD -- supabase/migrations supabase/schema-snapshot.txt`, commit. To reverse the schema itself, add a new migration; `rollback/` holds reviewed down-migrations to start from.
