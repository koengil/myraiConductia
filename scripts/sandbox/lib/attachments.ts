import type { Rng } from './prng';

const encoder = new TextEncoder();

/** Minimal placeholder bytes for sandbox attachments (fake content only). */
export function placeholderAttachment(filename: string, rng: Rng, dealCode: string): { contentType: string; content: Uint8Array } {
  const lower = filename.toLowerCase();
  const stamp = `Conductia sandbox placeholder — ${dealCode} — not real deal material.\nSeed byte: ${Math.floor(rng() * 256)}\n`;
  if (lower.endsWith('.pdf')) {
    const body = `%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n${stamp}`;
    return { contentType: 'application/pdf', content: encoder.encode(body) };
  }
  if (lower.endsWith('.docx')) {
    return { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: encoder.encode(`PK\x03\x04 fake-docx\n${stamp}`) };
  }
  if (lower.endsWith('.xlsx')) {
    return { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: encoder.encode(`PK\x03\x04 fake-xlsx\n${stamp}`) };
  }
  if (lower.endsWith('.pptx')) {
    return { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', content: encoder.encode(`PK\x03\x04 fake-pptx\n${stamp}`) };
  }
  return { contentType: 'application/octet-stream', content: encoder.encode(stamp) };
}
