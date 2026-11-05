import type { SeedAddress, SeedMessage } from './seedFormat';

const CRLF = '\r\n';
const encoder = new TextEncoder();

const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 B-encoded word for a header value that is not plain ASCII. */
function encodedWord(value: string): string {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function formatAddress({ name, address }: SeedAddress): string {
  if (!name) return address;
  const display = isAscii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodedWord(name);
  return `${display} <${address}>`;
}

/** Folds a long header to 78 columns at spaces, as RFC 5322 asks. */
function fold(line: string): string {
  if (line.length <= 78) return line;
  const words = line.split(' ');
  const lines: string[] = [];
  let current = words[0] ?? '';
  for (const word of words.slice(1)) {
    if (current.length + 1 + word.length > 78) {
      lines.push(current);
      current = ` ${word}`;
    } else {
      current += ` ${word}`;
    }
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Quoted-printable (RFC 2045) of a UTF-8 string with CRLF hard breaks and soft breaks under 76 columns. */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bytes = encoder.encode(rawLine);
    const tokens: string[] = [];
    bytes.forEach((byte, i) => {
      const last = i === bytes.length - 1;
      const printable = (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
      tokens.push(printable ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    });
    let line = '';
    for (const token of tokens) {
      if (line.length + token.length > 75) {
        out.push(`${line}=`);
        line = '';
      }
      line += token;
    }
    out.push(line);
  }
  return out.join(CRLF);
}

/** One RFC 822 message: CRLF headers, a single UTF-8 quoted-printable part.
 * The Message-ID is kept verbatim so every copy of a message shares it. */
export function buildRfc822(m: SeedMessage): Uint8Array {
  const headers: string[] = [
    `Message-ID: ${m.messageId}`,
    `Date: ${new Date(m.date).toUTCString().replace('GMT', '+0000')}`,
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(', ')}`,
  ];
  if (m.cc.length > 0) headers.push(`Cc: ${m.cc.map(formatAddress).join(', ')}`);
  headers.push(`Subject: ${encodedWord(m.subject)}`);
  if (m.inReplyTo) headers.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references && m.references.length > 0) headers.push(`References: ${m.references.join(' ')}`);
  for (const [name, value] of Object.entries(m.headers ?? {})) headers.push(`${name}: ${encodedWord(value)}`);
  headers.push(
    'MIME-Version: 1.0',
    `Content-Type: text/${m.body.contentType === 'html' ? 'html' : 'plain'}; charset=UTF-8`,
    'Content-Transfer-Encoding: quoted-printable',
  );
  const head = headers.map(fold).join(CRLF);
  return encoder.encode(`${head}${CRLF}${CRLF}${quotedPrintable(m.body.content)}${CRLF}`);
}
