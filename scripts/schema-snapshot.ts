import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

import {
  SNAPSHOT_PATH,
  formatSnapshot,
  hostOf,
  readSchemaCatalog,
  resolveDatabaseUrl,
} from './lib/schemaCatalog';

/*
 * Writes supabase/schema-snapshot.txt: every table, view, column, function and
 * policy in the public schema of a database the migrations just built, one per
 * line. CI rebuilds it on a freshly started local stack and fails when the
 * committed file differs, so a migration cannot change the schema without the
 * snapshot saying so. The promotion's preflight then requires production to
 * hold every line.
 *
 * Point it at the local stack only, never a lived-in database: anything that
 * exists there but not in the migrations would become a line production must
 * match.
 *
 *   npm run schema:snapshot -- <envfile with DATABASE_URL of the local stack>
 *
 * For the local stack, DATABASE_URL is the DB_URL from `supabase status -o env`
 * (by default postgresql://postgres:postgres@127.0.0.1:54322/postgres).
 */

function main(): void {
  const envFile = process.argv[2];
  if (!envFile) {
    throw new Error(
      'Name the env file of the database to read: npm run schema:snapshot -- <envfile>. ' +
        'Use the local stack after supabase db reset --local, never production.',
    );
  }
  const databaseUrl = resolveDatabaseUrl(envFile);
  const lines = readSchemaCatalog(databaseUrl);
  writeFileSync(SNAPSHOT_PATH, formatSnapshot(lines));
  console.log(
    `✅ Wrote ${lines.length} objects from ${hostOf(databaseUrl)} to ${relative(process.cwd(), SNAPSHOT_PATH)}.`,
  );
}

if (process.argv[1]?.endsWith('schema-snapshot.ts')) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
