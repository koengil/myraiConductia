// Attachment text for pre-send screening (Storm, Oct 9-10): the text of every
// attachment is read before a banker's email leaves, so the same compliance
// rules run on it as on the body.
//
// ok: true means all of the attachment's machine-readable text was read.
// Anything only partly read (a page without a text layer, a DOCX part this
// reader does not know, an image in a DOCX, text past the cap) is `partial`,
// so no unscreened text passes as clean. One known gap: on a PDF page that
// has a text layer, words that are only pictured (a scanned clause pasted
// beside typed text) are not read. Holding every PDF with an image would hold
// every letterhead; that trade is Storm's call (PR #536 review).
//
// One attachment in, one result out. The function never writes a file, never
// makes a request, and never logs or throws content: a parser error becomes a
// reason code. The caller FAILS CLOSED on every reason (an attachment that
// cannot be read is treated as needing review, never as clean).
//
// The kind is decided by the bytes (magic numbers), not by the name or MIME
// type. The declared name only matters when the bytes carry no signature:
// plain text has none, so text is read only when it is declared as text, and
// a file declared as PDF or DOCX whose bytes are not one is unreadable.
//
// PDF: unpdf (a serverless PDF.js build with no eval path, already a
// dependency), in process, with font loading off, bounded by page count and
// wall time (MAX_PDF_PAGES, PDF_TIMEOUT_MS) and, before PDF.js runs, by the
// bytes its streams decompress to (MAX_PDF_INFLATED_BYTES): the timeout
// cannot interrupt an inflate already in progress. DOCX: the zip is read here with node:zlib,
// capped against zip bombs, as the SharePoint extractor's child process does
// (src/lib/graph/reader/extract/child.mjs). That child runs sandboxed in the
// worker container; this path runs inside the send request, where a child
// process is not available.
//
// contentHash is the sha256 of the decoded bytes, decoded exactly as the
// outbox route decodes them, so it equals the sha256 the route already
// retains in attachment metadata.

import { createHash } from 'node:crypto';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';

export type AttachmentInput = { name: string; type?: string | null; contentBase64: string };

export type AttachmentTextKind = 'pdf' | 'docx' | 'text';

export const ATTACHMENT_TEXT_FAILURE = {
  UNSUPPORTED_TYPE: 'unsupported_type',
  TOO_LARGE: 'too_large',
  UNREADABLE: 'unreadable',
  ENCRYPTED: 'encrypted',
  EMPTY: 'empty',
  /** Some content could not be read (a page with no text layer, an embedded object, text past the cap). */
  PARTIAL: 'partial',
  /** Reading took longer than the send path allows. */
  TIMEOUT: 'timeout',
} as const;

export type AttachmentTextFailure = (typeof ATTACHMENT_TEXT_FAILURE)[keyof typeof ATTACHMENT_TEXT_FAILURE];

export type AttachmentTextResult =
  | {
      ok: true;
      kind: AttachmentTextKind;
      text: string;
      contentHash: string;
      charCount: number;
    }
  | { ok: false; reason: AttachmentTextFailure };

/** Decoded bytes per attachment. The outbox caps all attachments at ~3MB together. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Extracted text per attachment. Past it the attachment is `partial`: unscreened text never passes as clean. */
export const MAX_ATTACHMENT_TEXT_CHARS = 200_000;
/** PDF pages read per attachment. A longer PDF is too_large: the send request must stay bounded. */
export const MAX_PDF_PAGES = 300;
/** Wall time for reading one PDF inside the send request (the route allows 60s, the AI screen 25s). */
export const PDF_TIMEOUT_MS = 8_000;
/** Inflated XML across all DOCX parts read, against zip bombs. */
const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'md']);
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown']);
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// The DOCX parts a recipient can read: body, headers, footers, notes, comments.
const DOCX_TEXT_PART = /^word\/(?:document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/;
// Chart and SmartArt text (DrawingML): read with every tag as a separator.
const DOCX_DRAWING_PART = /^word\/(?:charts\/chart\d*|diagrams\/(?:data|drawing)\d*)\.xml$/;
// Document properties (title, subject, keywords, company, custom fields): a
// recipient sees them in File > Info, so they are read like drawing text.
const DOCX_PROPERTY_PART = /^docProps\/(?:core|app|custom)\.xml$/;
// Document settings: only their document variables (w:docVar values, which a
// DOCVARIABLE field shows in the text) carry words; the rest is formatting.
const DOCX_SETTINGS_PART = 'word/settings.xml';
// Parts that carry no text a recipient can read: package plumbing, styles,
// fonts, numbering, theme, and the layout halves of charts and SmartArt.
const DOCX_SILENT_PART = new RegExp(
  '^(?:\\[Content_Types\\]\\.xml|_rels/\\.rels|docProps/thumbnail\\.(?:jpe?g|png|emf|wmf)' +
    '|word/_rels/[^/]+\\.rels|word/(?:styles|stylesWithEffects|webSettings|fontTable|numbering|people' +
    '|commentsExtended|commentsIds|commentsExtensible)\\.xml|word/theme/theme(?:Override)?\\d*\\.xml|word/fonts/[^/]+' +
    '|word/printerSettings/printerSettings\\d*\\.bin|customXml/itemProps\\d*\\.xml|customXml/_rels/[^/]+\\.rels' +
    '|word/charts/(?:_rels/[^/]+\\.rels|colors\\d*\\.xml|style\\d*\\.xml)' +
    '|word/diagrams/(?:_rels/[^/]+\\.rels|layout\\d*\\.xml|quickStyle\\d*\\.xml|colors\\d*\\.xml))$',
);
// Anything else (images in word/media, embedded files, an afChunk HTML or
// RTF part, glossary building blocks, ActiveX, customXml data, a chart's
// embedded workbook) can hold text this reader never sees, so the document
// is partial: it holds the send instead of passing as fully read.
function isUnreadDocxPart(name: string): boolean {
  if (name.endsWith('/')) return false;
  return !(
    DOCX_TEXT_PART.test(name) ||
    DOCX_DRAWING_PART.test(name) ||
    DOCX_PROPERTY_PART.test(name) ||
    name === DOCX_SETTINGS_PART ||
    DOCX_SILENT_PART.test(name)
  );
}

type Declared = AttachmentTextKind | null;

function fail(reason: AttachmentTextFailure): AttachmentTextResult {
  return { ok: false, reason };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).trim().toLowerCase();
}

function declaredKind(name: string, type: string | null | undefined): Declared {
  const ext = extensionOf(name);
  const mime = (type ?? '').split(';')[0].trim().toLowerCase();
  if (ext === 'pdf' || mime === PDF_MIME) return 'pdf';
  if (ext === 'docx' || mime === DOCX_MIME) return 'docx';
  if (TEXT_EXTENSIONS.has(ext) || TEXT_MIME_TYPES.has(mime)) return 'text';
  return null;
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
// OLE compound file: legacy .doc/.xls/.ppt, and also the wrapper of a
// password-protected Office file.
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function isPdf(bytes: Buffer): boolean {
  // The spec allows leading junk; readers accept the header in the first 1KB.
  return bytes.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
}

function isEncryptedOfficeFile(bytes: Buffer): boolean {
  // An encrypted OOXML file is a compound file holding an "EncryptedPackage"
  // stream; directory entry names are UTF-16LE.
  return bytes.includes(Buffer.from('EncryptedPackage', 'utf16le'));
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Zero-width characters and soft hyphens would let "con\u200Bfidential" slip past a matcher.
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── PDF ──────────────────────────────────────────────────────────────────────

type PdfDocument = Awaited<ReturnType<(typeof import('unpdf'))['getDocumentProxy']>>;

/** Decompressed bytes across all of a PDF's streams. PDF.js cannot be stopped mid-inflate, so this is checked first. */
export const MAX_PDF_INFLATED_BYTES = 48 * 1024 * 1024;

// Filters this check cannot measure. LZW, run-length and Brotli expand on
// their own; ASCII85 and ASCIIHex can hide a Flate stream behind them;
// Encrypt hides every stream. PDF.js takes the short names on any stream, not
// only inline images, so they count too, matched after decoding (`/#4CZW`).
// Cost: a PDF whose inline images use run-length or ASCII filters (1 of 25
// real PDFs sampled, PR #537) holds; a narrower match could be fooled.
const UNMEASURABLE_NAMES = new Set([
  'LZWDecode', 'LZW', 'RunLengthDecode', 'RL', 'BrotliDecode', 'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx',
]);
const PDF_NAME = /\/([^\s/<>[\]()%{}]+)/g;

function decodePdfName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** The first name found that this check cannot measure past, or null. */
function unmeasurableName(text: string): AttachmentTextFailure | null {
  for (const match of text.matchAll(PDF_NAME)) {
    const name = decodePdfName(match[1]);
    if (name === 'Encrypt') return ATTACHMENT_TEXT_FAILURE.ENCRYPTED;
    if (UNMEASURABLE_NAMES.has(name)) return ATTACHMENT_TEXT_FAILURE.UNREADABLE;
  }
  return null;
}

const RAW_INFLATE = { finishFlush: zlibConstants.Z_SYNC_FLUSH } as const;
const isTooLarge = (error: unknown) => (error as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError;
/** zlib calls one PDF may cost the check. Ordinary PDFs need about one per compressed stream. */
const MAX_PDF_INFLATE_CALLS = 20_000;
/** A stream that inflates to another zlib stream, and so on: PDF.js decodes a /Filter array of Flates in turn. */
const MAX_PDF_INFLATE_DEPTH = 4;

type Measure = { budget: number; calls: number };

/** A valid zlib header (as PDF.js's FlateStream checks it) followed by a deflate block of a valid type. */
function startsZlib(bytes: Buffer, offset: number): boolean {
  const cmf = bytes[offset];
  const flg = bytes[offset + 1];
  const block = bytes[offset + 2];
  if (cmf === undefined || flg === undefined || block === undefined) return false;
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) return false;
  // BTYPE 3 is reserved: PDF.js fails on the first block and decodes nothing.
  return ((block >> 1) & 0x03) !== 3;
}

/**
 * What the zlib stream starting at `offset` inflates to (`over` once past the
 * budget, `calls` once the check has spent its zlib calls), or null when no
 * zlib stream starts there. Raw inflate skips the checksum, as PDF.js does.
 * A stream damaged part way still counts what its longest readable prefix
 * produces, since PDF.js keeps that much too.
 */
function inflatedAt(bytes: Buffer, offset: number, measure: Measure): Buffer | 'over' | 'calls' | null {
  if (!startsZlib(bytes, offset)) return null;
  const data = bytes.subarray(offset + 2);
  const inflate = (length: number, chunkSize?: number) => {
    measure.calls += 1;
    if (measure.calls > MAX_PDF_INFLATE_CALLS) throw new Error('calls');
    return inflateRawSync(data.subarray(0, length), {
      ...RAW_INFLATE,
      maxOutputLength: measure.budget + 1,
      ...(chunkSize ? { chunkSize } : {}),
    });
  };
  const outcome = (error: unknown) => (isTooLarge(error) ? 'over' : (error as Error).message === 'calls' ? 'calls' : null);
  // The longest prefix up to `high` bytes that still inflates (a truncated stream does).
  const longestPrefix = (high: number, chunkSize?: number): Buffer | 'over' | 'calls' => {
    let low = 0;
    let best: Buffer = Buffer.alloc(0);
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      try {
        best = inflate(mid, chunkSize);
        low = mid;
      } catch (error) {
        const stop = outcome(error);
        if (stop) return stop;
        high = mid - 1;
      }
    }
    return best;
  };
  // Most `stream` keywords are not followed by real deflate data, and fail
  // within a few bytes: a 1KB probe with small buffers settles those cheaply.
  const probe = Math.min(data.length, 1024);
  try {
    inflate(probe, 1024);
  } catch (error) {
    const stop = outcome(error);
    if (stop) return stop;
    return longestPrefix(probe - 1, 1024);
  }
  try {
    return inflate(data.length);
  } catch (error) {
    const stop = outcome(error);
    if (stop) return stop;
  }
  // Damaged past its first KB: what it produced counts against the budget, so
  // few of these fit before the cap.
  return longestPrefix(data.length - 1);
}

/** Counts one stream and, when its output is itself zlib data, the layers inside it. */
function measureStream(bytes: Buffer, offset: number, measure: Measure, depth: number): AttachmentTextFailure | null {
  const out = inflatedAt(bytes, offset, measure);
  if (!out) return null;
  if (out === 'over') return ATTACHMENT_TEXT_FAILURE.TOO_LARGE;
  if (out === 'calls') return ATTACHMENT_TEXT_FAILURE.UNREADABLE;
  measure.budget -= out.length;
  if (measure.budget < 0) return ATTACHMENT_TEXT_FAILURE.TOO_LARGE;
  const inner = unmeasurableName(out.toString('latin1'));
  if (inner) return inner;
  if (startsZlib(out, 0)) {
    if (depth >= MAX_PDF_INFLATE_DEPTH) return ATTACHMENT_TEXT_FAILURE.UNREADABLE;
    return measureStream(out, 0, measure, depth + 1);
  }
  return null;
}

/**
 * Bounds what PDF.js would decompress, before it runs, without trusting the
 * file's own structure (PR #537 review): every `stream` keyword anywhere in
 * the file, in a comment or a string included, is tried as the start of a
 * zlib stream, whatever its dictionary says, and everything that inflates,
 * layer after layer, counts against one shared cap. A filter that cannot be
 * measured this way, or encryption, named in the file or in any inflated
 * stream (an object stream holds other objects' dictionaries), fails closed.
 * The scan is linear in the file, and its zlib calls are capped.
 */
function pdfStreamsBounded(bytes: Buffer): AttachmentTextFailure | null {
  const source = bytes.toString('latin1');
  const named = unmeasurableName(source);
  if (named) return named;
  const measure: Measure = { budget: MAX_PDF_INFLATED_BYTES, calls: 0 };
  // PDF.js starts stream data after the end of the line holding `stream`
  // (Lexer.skipToNextLine: CR LF, CR or LF, however long the line). The next
  // CR and LF are cached, so many `stream`s on one line cost one search.
  const next = (char: string, from: number) => {
    const at = source.indexOf(char, from);
    return at === -1 ? Number.POSITIVE_INFINITY : at;
  };
  let nextCr = -1;
  let nextLf = -1;
  let lastStart = -1;
  for (let at = source.indexOf('stream'); at !== -1; at = source.indexOf('stream', at + 1)) {
    const from = at + 'stream'.length;
    if (nextCr < from) nextCr = next('\r', from);
    if (nextLf < from) nextLf = next('\n', from);
    const eol = Math.min(nextCr, nextLf);
    if (eol === Number.POSITIVE_INFINITY) break;
    const start = eol === nextCr && source[eol + 1] === '\n' ? eol + 2 : eol + 1;
    if (start === lastStart) continue;
    lastStart = start;
    const failure = measureStream(bytes, start, measure, 1);
    if (failure) return failure;
  }
  return null;
}

async function pdfText(bytes: Buffer, timeoutMs: number): Promise<{ text: string } | { reason: AttachmentTextFailure }> {
  let pdf: PdfDocument | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async (): Promise<{ text: string } | { reason: AttachmentTextFailure }> => {
    const { getDocumentProxy, extractText } = await import('unpdf');
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    if (timedOut) return { reason: ATTACHMENT_TEXT_FAILURE.TIMEOUT };
    // Bounded before any page is read: cost grows with pages, not bytes.
    if (pdf.numPages > MAX_PDF_PAGES) return { reason: ATTACHMENT_TEXT_FAILURE.TOO_LARGE };
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((page) => (typeof page === 'string' ? page : ''));
    const blank = pages.filter((page) => page.trim() === '').length;
    // Every page blank is a scan (empty, below). Some pages blank is a document
    // only partly read (scanned pages, a recovered damaged file): never clean.
    if (blank > 0 && blank < pages.length) return { reason: ATTACHMENT_TEXT_FAILURE.PARTIAL };
    return { text: pages.join('\n') };
  })();
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const outcome = await Promise.race([read, deadline]);
    if (outcome === 'timeout') {
      timedOut = true;
      // The abandoned read may still settle; its result and any error are dropped.
      read.catch(() => undefined);
      return { reason: ATTACHMENT_TEXT_FAILURE.TIMEOUT };
    }
    return outcome;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'PasswordException') {
      return { reason: ATTACHMENT_TEXT_FAILURE.ENCRYPTED };
    }
    // The message may quote document content, so it is dropped here.
    return { reason: ATTACHMENT_TEXT_FAILURE.UNREADABLE };
  } finally {
    clearTimeout(timer);
    // Stops a timed-out read at its next page and frees the parsed document
    // (this PDF.js build has no PDFDocumentProxy.destroy; the loading task does it).
    const destroy = () => {
      pdf?.loadingTask.destroy().catch(() => undefined);
    };
    if (pdf) destroy();
    else read.then(destroy, () => undefined);
  }
}

// ── DOCX: a zip holding word/document.xml ────────────────────────────────────

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number };

function zipEntries(buf: Buffer): ZipEntry[] {
  const floor = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const nameLength = buf.readUInt16LE(offset + 28);
    entries.push({
      name: buf.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: buf.readUInt16LE(offset + 10),
      compressedSize: buf.readUInt32LE(offset + 20),
      localOffset: buf.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return entries;
}

function zipEntryData(buf: Buffer, entry: ZipEntry, maxOutputLength: number): Buffer {
  const local = entry.localOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new Error('truncated entry');
  if (entry.method === 0) {
    if (data.length > maxOutputLength) throw new Error('entry too large');
    return data;
  }
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength });
  throw new Error('unsupported zip method');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function wordXmlText(xml: string): string {
  // Alt text on pictures and shapes lives in attributes the tag strip drops.
  const altText = [...xml.matchAll(/<wp:docPr\b[^>]*?\sdescr="([^"]*)"/g)].map((m) => m[1]);
  return decodeEntities(
    [
      xml
        // Elements that separate words, with or without attributes (a page
        // break is <w:br w:type="page"/>): replaced, never fused.
        .replace(/<w:(?:tab|ptab)\b[^>]*\/>/g, '\t')
        .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
        .replace(/<w:noBreakHyphen\b[^>]*\/>/g, '-')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, ''),
      ...altText,
    ].join('\n'),
  );
}

function docVarText(xml: string): string {
  return decodeEntities([...xml.matchAll(/<w:docVar\b[^>]*?\sw:val="([^"]*)"/g)].map((m) => m[1]).join('\n'));
}

function drawingXmlText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ' '));
}

/** null: the zip is not a Word document; 'partial': it holds a part this reader cannot read. Throws when the zip is damaged. */
function docxText(bytes: Buffer): string | null | 'partial' {
  const entries = zipEntries(bytes);
  if (!entries.some((entry) => entry.name === 'word/document.xml')) return null;
  if (entries.some((entry) => isUnreadDocxPart(entry.name))) return 'partial';
  // Body first, then the other readable parts in archive order.
  const parts = entries
    .filter(
      (entry) =>
        DOCX_TEXT_PART.test(entry.name) ||
        DOCX_DRAWING_PART.test(entry.name) ||
        DOCX_PROPERTY_PART.test(entry.name) ||
        entry.name === DOCX_SETTINGS_PART,
    )
    .sort((a, b) => Number(b.name === 'word/document.xml') - Number(a.name === 'word/document.xml'));
  let budget = MAX_DOCX_XML_BYTES;
  const texts: string[] = [];
  for (const part of parts) {
    if (budget <= 0) throw new Error('document too large');
    const xml = zipEntryData(bytes, part, budget);
    budget -= xml.length;
    const source = xml.toString('utf8');
    texts.push(
      DOCX_TEXT_PART.test(part.name)
        ? wordXmlText(source)
        : part.name === DOCX_SETTINGS_PART
          ? docVarText(source)
          : drawingXmlText(source),
    );
  }
  return texts.join('\n\n');
}

// ── Plain text ───────────────────────────────────────────────────────────────

function plainText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    // Strict UTF-8 (a leading BOM is dropped). Other encodings are unreadable.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function extractAttachmentText(
  attachment: AttachmentInput,
  opts: { pdfTimeoutMs?: number } = {},
): Promise<AttachmentTextResult> {
  const base64 = typeof attachment.contentBase64 === 'string' ? attachment.contentBase64 : '';
  // Refuse before decoding: 4 base64 chars per 3 bytes, plus padding and line breaks.
  if (base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 * 1.1 + 16) return fail(ATTACHMENT_TEXT_FAILURE.TOO_LARGE);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES) return fail(ATTACHMENT_TEXT_FAILURE.TOO_LARGE);
  if (bytes.length === 0) return fail(ATTACHMENT_TEXT_FAILURE.EMPTY);

  const declared = declaredKind(attachment.name ?? '', attachment.type);
  let kind: AttachmentTextKind;
  let raw: string;

  const sniffed: AttachmentTextKind | null = isPdf(bytes) ? 'pdf' : startsWith(bytes, ZIP_SIGNATURE) ? 'docx' : null;
  // A declared kind the bytes contradict (a polyglot, a renamed file) is not guessed at.
  if (sniffed && declared && declared !== sniffed) return fail(ATTACHMENT_TEXT_FAILURE.UNREADABLE);

  if (sniffed === 'pdf') {
    kind = 'pdf';
    const unbounded = pdfStreamsBounded(bytes);
    if (unbounded) return fail(unbounded);
    const parsed = await pdfText(bytes, opts.pdfTimeoutMs ?? PDF_TIMEOUT_MS);
    if ('reason' in parsed) return fail(parsed.reason);
    raw = parsed.text;
  } else if (sniffed === 'docx') {
    kind = 'docx';
    let parsed: string | null | 'partial';
    try {
      parsed = docxText(bytes);
    } catch {
      return fail(ATTACHMENT_TEXT_FAILURE.UNREADABLE);
    }
    // Spreadsheets, decks and plain archives are zips too.
    if (parsed === null) return fail(ATTACHMENT_TEXT_FAILURE.UNSUPPORTED_TYPE);
    if (parsed === 'partial') return fail(ATTACHMENT_TEXT_FAILURE.PARTIAL);
    raw = parsed;
  } else if (startsWith(bytes, CFB_SIGNATURE)) {
    // Either a password-protected Office file or a legacy binary (.doc/.xls).
    return fail(isEncryptedOfficeFile(bytes) ? ATTACHMENT_TEXT_FAILURE.ENCRYPTED : ATTACHMENT_TEXT_FAILURE.UNSUPPORTED_TYPE);
  } else if (declared === 'pdf' || declared === 'docx') {
    // Declared as a document, but the bytes are not one.
    return fail(ATTACHMENT_TEXT_FAILURE.UNREADABLE);
  } else if (declared === 'text') {
    kind = 'text';
    const parsed = plainText(bytes);
    if (parsed === null) return fail(ATTACHMENT_TEXT_FAILURE.UNREADABLE);
    raw = parsed;
  } else {
    return fail(ATTACHMENT_TEXT_FAILURE.UNSUPPORTED_TYPE);
  }

  const normalized = normalizeWhitespace(raw);
  // A PDF with pages but no text layer (a scan) lands here too.
  if (normalized.length === 0) return fail(ATTACHMENT_TEXT_FAILURE.EMPTY);
  // Text past the cap would go unscreened, so the attachment is partial, never clean.
  if (normalized.length > MAX_ATTACHMENT_TEXT_CHARS) return fail(ATTACHMENT_TEXT_FAILURE.PARTIAL);
  return {
    ok: true,
    kind,
    text: normalized,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    charCount: normalized.length,
  };
}
