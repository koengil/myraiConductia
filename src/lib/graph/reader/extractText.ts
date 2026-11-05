// Attachment text extraction for SharePoint documents (phase 4), sandboxed.
//
// Parsing a PDF or a DOCX means running a parser over bytes from outside the
// firm, so it never happens in the worker process. Each document is handed to
// a short-lived child (extract/child.mjs) that runs under Node's permission
// model with:
//   - read access to its own script and the unpdf package only; no write, no
//     child processes, no worker threads, no native addons;
//   - an empty environment, so no secret is in reach;
//   - a 256 MB heap, the bytes on stdin, and a hard timeout (SIGKILL);
//   - a cap on how much it may answer.
// Node 22's --permission does NOT restrict the network: a parser exploit in
// the child could still open a socket. The child makes no request by design,
// and the empty environment leaves it nothing to authenticate with, but the
// network boundary is the worker container's egress rule, which allows only
// Graph, Entra sign-in and the Key Vault host (scripts/m365/README.md, step 5).
//
// Image files are out of scope for the demo (no OCR): they are never read,
// never spawned, and the ledger records them as image_only. A PDF without a
// text layer (a scan) is reported the same way.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { EXTRACT_MAX_BYTES, SKIP_REASON, type PolicySkipReason, type SkipReason } from '@/lib/constants/discovery';

export type DocumentFormat = 'pdf' | 'docx' | 'text';

/** What a file is, from its name and MIME type, before anything reads it. */
/** Why a document is ledgered without text: the extractor's reasons, never the exclusion policy's (those are a message's). */
export type DocumentSkipReason = Exclude<SkipReason, PolicySkipReason>;
export type DocumentClass = { kind: 'extract'; format: DocumentFormat } | { kind: 'skip'; reason: DocumentSkipReason };

export type ExtractResult = { ok: true; text: string } | { ok: false; reason: DocumentSkipReason };

export const EXTRACT_DEFAULTS = {
  /** Larger files are ledgered as too_large and never downloaded. The number lives in constants/discovery.ts (the recorder bounds a capture with it). */
  maxBytes: EXTRACT_MAX_BYTES,
  timeoutMs: 20_000,
  /** Stored text per document; the rest is dropped. */
  maxTextChars: 200_000,
  heapMb: 256,
} as const;

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif', 'svg', 'ico',
]);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv']);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function classifyDocument(name: string, mimeType: string | null | undefined, size: number | null | undefined): DocumentClass {
  const ext = extensionOf(name);
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return { kind: 'skip', reason: SKIP_REASON.IMAGE_ONLY };
  let format: DocumentFormat | null = null;
  if (ext === 'pdf' || mime === 'application/pdf') format = 'pdf';
  else if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') format = 'docx';
  else if (TEXT_EXTENSIONS.has(ext) || mime === 'text/plain') format = 'text';
  if (!format) return { kind: 'skip', reason: SKIP_REASON.UNSUPPORTED_TYPE };
  if (typeof size === 'number' && size > EXTRACT_DEFAULTS.maxBytes) return { kind: 'skip', reason: SKIP_REASON.TOO_LARGE };
  return { kind: 'extract', format };
}

/** The child script. Resolved from the working directory, as the fixture corpus is. */
export function defaultChildScript(): string {
  return join(process.cwd(), 'src', 'lib', 'graph', 'reader', 'extract', 'child.mjs');
}

function unpdfEntry(): string {
  return createRequire(join(process.cwd(), 'package.json')).resolve('unpdf');
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type ExtractOptions = {
  timeoutMs?: number;
  maxTextChars?: number;
  childScript?: string;
  /** Injected in tests; defaults to node:child_process spawn. */
  spawnImpl?: SpawnFn;
};

export async function extractText(bytes: Uint8Array, format: DocumentFormat, options: ExtractOptions = {}): Promise<ExtractResult> {
  const timeoutMs = options.timeoutMs ?? EXTRACT_DEFAULTS.timeoutMs;
  const maxTextChars = options.maxTextChars ?? EXTRACT_DEFAULTS.maxTextChars;
  const childScript = options.childScript ?? defaultChildScript();
  const entry = unpdfEntry();
  const spawnImpl: SpawnFn = options.spawnImpl ?? spawn;
  // Enough for maxTextChars of multi-byte text plus the JSON around it.
  const maxStdout = maxTextChars * 4 + 4096;

  return new Promise<ExtractResult>((resolve) => {
    let settled = false;
    const finish = (result: ExtractResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawnImpl(
      process.execPath,
      [
        `--max-old-space-size=${EXTRACT_DEFAULTS.heapMb}`,
        '--permission',
        `--allow-fs-read=${childScript}`,
        `--allow-fs-read=${dirname(dirname(entry))}/`,
        childScript,
        format,
        entry,
      ],
      // No environment at all: nothing secret is in reach of the parser.
      { env: {} as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'] },
    );

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: SKIP_REASON.EXTRACTION_TIMEOUT });
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let received = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxStdout) {
        child.kill('SIGKILL');
        finish({ ok: false, reason: SKIP_REASON.EXTRACTION_FAILED });
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => finish({ ok: false, reason: SKIP_REASON.EXTRACTION_FAILED }));
    child.on('close', () => {
      const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter((line) => line.trim());
      const last = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(last ?? '') as { ok?: unknown; text?: unknown; reason?: unknown };
        if (parsed.ok === true && typeof parsed.text === 'string') {
          finish({ ok: true, text: parsed.text.slice(0, maxTextChars) });
        } else if (parsed.reason === SKIP_REASON.IMAGE_ONLY) {
          finish({ ok: false, reason: SKIP_REASON.IMAGE_ONLY });
        } else {
          finish({ ok: false, reason: SKIP_REASON.EXTRACTION_FAILED });
        }
      } catch {
        finish({ ok: false, reason: SKIP_REASON.EXTRACTION_FAILED });
      }
    });

    child.stdin?.on('error', () => undefined);
    child.stdin?.end(Buffer.from(bytes));
  });
}
