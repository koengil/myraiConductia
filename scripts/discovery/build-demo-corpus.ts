// Builds every committed output of the deal-discovery demo corpus from its one
// hand-written source, tests/fixtures/discovery/demo/corpus.json. Offline and
// deterministic. It imports no reader (fence D) and no @/lib module: the base
// fixtures are read with fs.
//
//   node --import tsx scripts/discovery/build-demo-corpus.ts [--check]
//
// Outputs (all committed):
//   tests/fixtures/discovery/demo/graph/mailbox-<persona>.json
//       base fixture messages verbatim, then the seeded demo messages by date
//   tests/fixtures/discovery/demo/graph-after-imports/mailbox-<persona>.json
//       the same, then the after-imports messages appended last
//   tests/fixtures/discovery/demo/gmail-seed.jsonl
//       every demo message, one SeedMessage per line, corpus order
//   src/lib/modelGateway/syntheticCorpus.generated.ts
//       the Message-IDs of base + demo and the corpus digest
//
// --check builds in memory, compares with the files on disk, lists each path
// that differs and exits 1.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { DEMO_PERSONAS, readCorpus, type MailCorpusV1, type SeedMessage } from './lib/mailCorpus';

const ROOT = process.cwd();
const BASE_DIR = join(ROOT, 'tests/fixtures/discovery');
const DEMO_DIR = join(BASE_DIR, 'demo');
const GRAPH_DIR = join(DEMO_DIR, 'graph');
const LATE_DIR = join(DEMO_DIR, 'graph-after-imports');
const CORPUS_PATH = join(DEMO_DIR, 'corpus.json');
const GMAIL_SEED = join(DEMO_DIR, 'gmail-seed.jsonl');
const SYNTHETIC_TS = join(ROOT, 'src/lib/modelGateway/syntheticCorpus.generated.ts');

// The shape of tests/fixtures/discovery/*.json, declared here so this script
// does not import the reader (its type lives in @/lib/graph/reader).
type GraphRecipient = { emailAddress: { name?: string | null; address: string } };
type GraphMessage = {
  id: string;
  internetMessageId: string;
  conversationId: string | null;
  subject: string | null;
  sentDateTime: string | null;
  receivedDateTime?: string | null;
  from: GraphRecipient | null;
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  body: { contentType: 'html' | 'text'; content: string };
  hasAttachments?: boolean;
};
export type FixtureMailbox = { mailbox: string; messages: GraphMessage[] };

type GraphOut = GraphMessage & { internetMessageHeaders?: { name: string; value: string }[] };

function recipient(a: { name?: string; address: string }): GraphRecipient {
  return { emailAddress: { name: a.name ?? null, address: a.address } };
}

export function toGraph(mailbox: string, m: SeedMessage): GraphOut {
  const root = m.references?.[0] ?? m.inReplyTo ?? m.messageId;
  const headers = [
    ...(m.inReplyTo ? [{ name: 'In-Reply-To', value: m.inReplyTo }] : []),
    ...(m.references?.length ? [{ name: 'References', value: m.references.join(' ') }] : []),
  ];
  return {
    id: createHash('sha256').update(`${mailbox}|${m.messageId}`).digest('hex').slice(0, 16),
    internetMessageId: m.messageId,
    conversationId: `rfc822:${root}`, // #259 R18: never lowercased
    subject: m.subject,
    sentDateTime: new Date(m.date).toISOString(),
    from: recipient(m.from),
    toRecipients: m.to.map(recipient),
    ccRecipients: m.cc.map(recipient),
    body: m.body,
    ...(headers.length ? { internetMessageHeaders: headers } : {}),
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Stable by date, then by corpus order. */
function byDate(messages: SeedMessage[]): SeedMessage[] {
  return messages
    .map((m, index) => ({ m, index }))
    .sort((a, b) => Date.parse(a.m.date) - Date.parse(b.m.date) || a.index - b.index)
    .map(({ m }) => m);
}

export function buildOutputs(corpus: MailCorpusV1, base: FixtureMailbox[]): Map<string, string> {
  const out = new Map<string, string>();
  const seeded = corpus.messages.filter((m) => (m.phase ?? 'seeded') === 'seeded');
  const late = corpus.messages.filter((m) => m.phase === 'after-imports');

  for (const [address, slug] of Object.entries(DEMO_PERSONAS)) {
    const held = (list: SeedMessage[]) => list.filter((m) => m.mailboxes.includes(address));
    const baseMessages = base.find((b) => b.mailbox.toLowerCase() === address)?.messages ?? [];
    const build = (extra: SeedMessage[]): string =>
      json({
        mailbox: address,
        messages: [...baseMessages, ...extra.map((m) => toGraph(address, m))],
      });
    out.set(join(GRAPH_DIR, `mailbox-${slug}.json`), build(byDate(held(seeded))));
    out.set(join(LATE_DIR, `mailbox-${slug}.json`), build([...byDate(held(seeded)), ...byDate(held(late))]));
  }

  out.set(GMAIL_SEED, corpus.messages.map((m) => `${JSON.stringify(m)}\n`).join(''));

  const ids = [
    ...new Set([...base.flatMap((b) => b.messages.map((m) => m.internetMessageId)), ...corpus.messages.map((m) => m.messageId)]),
  ].sort();
  const digest = createHash('sha256').update(readFileSync(CORPUS_PATH)).digest('hex');
  out.set(
    SYNTHETIC_TS,
    [
      '// GENERATED by scripts/discovery/build-demo-corpus.ts. Do not edit.',
      '// The Message-IDs of the committed synthetic corpora (tests/fixtures/discovery',
      "// base + demo). The processor gate's synthetic path sends only these (design R19).",
      `export const SYNTHETIC_CORPUS_DIGEST = 'sha256:${digest}';`,
      'export const SYNTHETIC_MESSAGE_IDS: ReadonlySet<string> = new Set([',
      ...ids.map((id) => `  '${id}',`),
      ']);',
      '',
    ].join('\n'),
  );
  return out;
}

function loadBase(): FixtureMailbox[] {
  return readdirSync(BASE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(BASE_DIR, name), 'utf8')) as FixtureMailbox);
}

/** JSON files in the generated directories that no output accounts for. */
function strayFiles(outputs: Map<string, string>): string[] {
  return [GRAPH_DIR, LATE_DIR].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .map((name) => join(dir, name))
          .filter((path) => !outputs.has(path))
      : [],
  );
}

function main(): void {
  const check = process.argv.includes('--check');
  const outputs = buildOutputs(readCorpus(CORPUS_PATH), loadBase());
  const rel = (path: string) => relative(ROOT, path);

  if (check) {
    const differing = [
      ...[...outputs]
        .filter(([path, content]) => !existsSync(path) || readFileSync(path, 'utf8') !== content)
        .map(([path]) => rel(path)),
      ...strayFiles(outputs).map((path) => `${rel(path)} (not generated)`),
    ];
    if (differing.length > 0) {
      console.error('Demo corpus outputs are stale. Run `npm run discovery:build-demo-corpus` and commit:');
      for (const path of differing) console.error(`  ${path}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Demo corpus outputs are current (${outputs.size} files).`);
    return;
  }

  for (const [path, content] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`Wrote ${outputs.size} demo corpus files.`);
}

if (process.argv[1]?.endsWith('build-demo-corpus.ts')) main();
