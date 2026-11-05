import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GMAIL_REPLAY_FORMAT, type GmailReplay } from '../../src/lib/google/replay/format';
import { argValue } from './lib/live';
import { scrubReplay } from './lib/scrub';

// Joins the recorder's per-phase files into the one file per mailbox the
// replay reader loads (#259 phase 6). Offline: it reads files, it contacts
// nothing and imports no reader.
//
//   node --import tsx scripts/google/merge-replay.ts --dir <recorder --out dir> --out <dir>
//
// <dir>/<persona>.<phase>.json (seeded, after-imports, after-unspam) becomes
// <out>/<persona>.replay.json with every phase. The merge runs the scrubber
// again, so a file that gained a secret-shaped string after recording is
// refused. The owner reviews the result before it enters the repo (Oct 8): for
// the fixture corpus that is tests/fixtures/discovery/gmail; the Tidewell
// recording stays outside the repo. Never overwrites.

const FILE = /^(.+)\.([a-z0-9-]+)\.json$/;

export function mergeReplays(files: Array<{ name: string; replay: GmailReplay }>): GmailReplay[] {
  const merged = new Map<string, GmailReplay>();
  for (const { name, replay } of files) {
    if (replay.format !== GMAIL_REPLAY_FORMAT) throw new Error(`${name} is not a ${GMAIL_REPLAY_FORMAT} file`);
    const existing = merged.get(replay.mailbox);
    if (!existing) {
      merged.set(replay.mailbox, { ...replay, phases: { ...replay.phases } });
      continue;
    }
    for (const [phase, keys] of Object.entries(replay.phases)) {
      if (existing.phases[phase]) throw new Error(`${replay.mailbox} has phase ${phase} in more than one file`);
      existing.phases[phase] = keys;
    }
    existing.synthetic = existing.synthetic && replay.synthetic;
  }
  return [...merged.values()].map((replay) => scrubReplay(replay)).sort((a, b) => a.mailbox.localeCompare(b.mailbox));
}

function main(): void {
  const dir = argValue(process.argv, '--dir');
  const out = argValue(process.argv, '--out');
  if (!dir || !out) throw new Error('Usage: merge-replay.ts --dir <recorder output dir> --out <dir>');
  const files = readdirSync(resolve(dir))
    .filter((name) => FILE.test(name) && !name.endsWith('.replay.json'))
    .sort()
    .map((name) => ({ name, replay: JSON.parse(readFileSync(join(resolve(dir), name), 'utf8')) as GmailReplay }));
  if (files.length === 0) throw new Error(`No <persona>.<phase>.json files in ${dir}`);
  mkdirSync(resolve(out), { recursive: true });
  for (const replay of mergeReplays(files)) {
    const target = join(resolve(out), `${replay.mailbox}.replay.json`);
    if (existsSync(target)) throw new Error(`Refusing to overwrite ${target}`);
    writeFileSync(target, `${JSON.stringify(replay, null, 2)}\n`, { flag: 'wx' });
    console.log(`merged ${replay.mailbox}: ${Object.keys(replay.phases).join(', ')} -> ${target}`);
  }
}

if (process.argv[1]?.endsWith('merge-replay.ts')) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
