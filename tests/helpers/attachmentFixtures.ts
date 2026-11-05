// Synthetic attachment fixtures, built in memory: PDFs with or without a text
// layer, and deflated zip archives (DOCX is a zip). Shared by the extractor
// tests and the outbox send-path tests.
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

/** A one-page PDF. `pageText` null leaves the page without a text layer (a scan). */
export function buildPdf(pageText: string | null, encrypted = false): Buffer {
  const stream = pageText === null ? '' : `BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // Standard security handler whose /U does not match the empty password, so
  // opening it needs a password.
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -4 >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const id = '<0123456789abcdef0123456789abcdef>';
  const extra = encrypted ? `/Encrypt 6 0 R /ID [${id}${id}] ` : '';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${extra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A PDF with one page per entry; a null entry is a page with no text layer (a scan). */
export function buildPdfPages(pages: (string | null)[]): Buffer {
  const fontId = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    const stream = text === null ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * A one-page PDF whose content stream is compressed, as real PDFs are.
 * `padding` bytes of spaces follow the text inside the stream, so a small file
 * can decompress to a large one; `filter` replaces the stream's /Filter.
 */
export function buildCompressedPdf(pageText: string, padding = 0, filter = '/FlateDecode'): Buffer {
  const content = Buffer.concat([Buffer.from(`BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET\n`, 'latin1'), Buffer.alloc(padding, 0x20)]);
  const stream = deflateSync(content);
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(buf);
    length += buf.length;
  };
  push('%PDF-1.4\n');
  const objects: (string | [string, Buffer])[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    [`<< /Length ${stream.length} /Filter ${filter} >>`, stream],
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  objects.forEach((body, i) => {
    offsets.push(length);
    if (typeof body === 'string') push(`${i + 1} 0 obj\n${body}\nendobj\n`);
    else {
      push(`${i + 1} 0 obj\n${body[0]}\nstream\n`);
      push(body[1]);
      push('\nendstream\nendobj\n');
    }
  });
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  push(offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join(''));
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** A deflated zip archive. */
export function buildZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
