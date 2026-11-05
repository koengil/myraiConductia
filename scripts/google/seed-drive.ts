// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The Google primitives come through
// the operator door, never from a reader module (tests/mailbox-access-pins.test.ts).
import { googleOperatorKit } from '../../src/lib/mailboxAccess/readers';

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

import { GOOGLE_TOOL_SCOPE } from '../../src/lib/constants/googleReader';
import { announceLiveRun, argValue, assertOutsideRepo, assertSecretsFolderKeyless, requireLiveRun } from './lib/live';
import { buildMultipartRelated, newBoundary } from './lib/multipart';
import { loadSeedingConfig, trialDomain } from './lib/seedConfig';

const { createCallerTokenSource, googleJson, serviceAccountAccessToken } = googleOperatorKit();

// Uploads a directory of files (the Tidewell corpus, kept outside the repo) to a
// shared drive as the seeding service account (drive.file), then adds the Drive
// probe service account as a Viewer. Records ids only, never file content.
// Announce the run to the owner first.
//
//   npm run google:seed-drive -- --live --confirm-domain <trial domain> \
//     --dir "$TIDEWELL_CORPUS_DIR" [--drive-id <shared drive id>] \
//     [--seeding-config .secrets/google/seeding.json] [--out <dir outside the repo>]

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

async function main(): Promise<void> {
  const argv = process.argv;
  const dir = argValue(argv, '--dir');
  if (!dir) throw new Error('--dir <corpus directory outside the repo> is required');
  assertOutsideRepo(dir);

  assertSecretsFolderKeyless(resolve('.secrets'));
  const config = loadSeedingConfig(argValue(argv, '--seeding-config') ?? '.secrets/google/seeding.json');
  const domain = trialDomain(config);
  requireLiveRun(argv, domain, { testDomains: config.testDomains });
  const driveId = argValue(argv, '--drive-id') ?? config.sharedDriveId;
  if (!driveId) throw new Error('--drive-id or sharedDriveId in seeding.json is required');
  const outDir = assertOutsideRepo(argValue(argv, '--out') ?? join(homedir(), '.conductia', 'google-seed'));

  announceLiveRun('google:seed-drive', domain, config.seedingServiceAccountEmail);
  const token = await serviceAccountAccessToken(createCallerTokenSource(), config.seedingServiceAccountEmail, [
    GOOGLE_TOOL_SCOPE.DRIVE_FILE_SEEDING,
  ]);
  const http = { getToken: async () => token };

  const uploaded: Array<{ name: string; id: string }> = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const boundary = newBoundary();
    const mime = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
    const body = buildMultipartRelated(boundary, { name, parents: [driveId] }, readFileSync(path), mime);
    const file = await googleJson<{ id: string }>(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
      http,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: body as unknown as BodyInit },
    );
    uploaded.push({ name, id: file.id });
    console.log(`uploaded ${name} -> ${file.id}`);
  }

  if (config.driveProbeServiceAccountEmail) {
    await googleJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
      http,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: config.driveProbeServiceAccountEmail }),
      },
    );
    console.log(`added ${config.driveProbeServiceAccountEmail} as a Viewer of drive ${driveId}`);
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outDir, `${domain}.drive.json`), JSON.stringify({ driveId, uploaded }, null, 2), { mode: 0o600 });
  console.log(`Done: ${uploaded.length} files (ids recorded in ${outDir})`);
}

if (process.argv[1]?.endsWith('seed-drive.ts')) {
  main().catch((error: unknown) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
