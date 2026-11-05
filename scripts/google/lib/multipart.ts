const encoder = new TextEncoder();

/** A multipart/related body: one JSON metadata part and one binary media part
 * (Gmail messages.import and Drive files.create both take this shape). */
export function buildMultipartRelated(
  boundary: string,
  metadata: unknown,
  media: Uint8Array,
  mediaType: string,
): Uint8Array {
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + media.length + tail.length);
  out.set(head, 0);
  out.set(media, head.length);
  out.set(tail, head.length + media.length);
  return out;
}

export function newBoundary(): string {
  return `conductia-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
