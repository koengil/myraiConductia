// The attachment text extractor's child process (phase 4). It is the only
// code that parses a document's bytes, and it runs apart from the worker:
//
//   node --max-old-space-size=256 --permission --allow-fs-read=<this file>
//        --allow-fs-read=<unpdf dir> child.mjs <format> <unpdf entry>
//
// The parent (extractText.ts) gives it an empty environment (no secrets), no
// write, spawn or worker permissions, the bytes on stdin, and a hard timeout
// after which it is SIGKILLed. It answers one line of JSON on stdout:
//
//   { "ok": true, "text": "..." } | { "ok": false, "reason": "image_only" | "extraction_failed" }
//
// Formats: pdf (unpdf, a serverless PDF.js build, with eval and font loading
// off), docx (read here from the zip with node:zlib, capped against zip
// bombs), text (UTF-8). Images never reach this process: the parent ledgers
// them as image_only without spawning.

import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const MAX_XML_BYTES = 20 * 1024 * 1024;

function answer(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function pdfText(bytes, unpdfEntry) {
  const { getDocumentProxy, extractText } = await import(pathToFileURL(unpdfEntry).href);
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    // Errors only: PDF.js warnings would otherwise share stdout with the answer.
    verbosity: 0,
  });
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === 'string' ? text : '';
}

// ── DOCX: a zip holding word/document.xml ────────────────────────────────────

function findEndOfCentralDirectory(buf) {
  const floor = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip file');
}

function zipEntry(buf, wanted) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      throw new Error(`unsupported zip method ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wanted} not found`);
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function docxText(bytes) {
  const xml = zipEntry(bytes, 'word/document.xml').toString('utf8');
  const text = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(?:br|cr)\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text);
}

async function main() {
  const [format, unpdfEntry] = process.argv.slice(2);
  const bytes = await readStdin();
  let text;
  if (format === 'pdf') text = await pdfText(bytes, unpdfEntry);
  else if (format === 'docx') text = docxText(bytes);
  else if (format === 'text') text = bytes.toString('utf8');
  else throw new Error(`unknown format ${format}`);

  const trimmed = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // A PDF with pages but no text layer is a scan: out of scope, not a failure.
  if (trimmed.length === 0 && format === 'pdf') return answer({ ok: false, reason: 'image_only' });
  return answer({ ok: true, text: trimmed });
}

main().catch(() => {
  // The message may quote document content, so it never leaves this process.
  answer({ ok: false, reason: 'extraction_failed' });
});
