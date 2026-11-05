import { ALLOWED_RESPONSE_HEADERS, type CassetteData } from './format';
import { pagingValues } from './paging';

// The credential and correlation check (CDT-277). One lint guards the recorder (saveCassette), the
// loader (loadCassette) and CI (tests/cassette-lint.test.ts). It proves the scrub rules worked: it
// never trusts them.

export type LintRule = 'jwt' | 'bearer' | 'tempauth' | 'key-material' | 'token-field' | 'header' | 'paging-token' | 'host' | 'error-body';
/** Names the rule and where, never the value: e.g. { rule: 'tempauth', where: 'interactions[12].headers.location' }. */
export type LintFinding = { rule: LintRule; where: string };

// Tight enough that a word in a synthetic email cannot block a recording, loose enough to catch a credential.
const TEXT_RULES: Array<[LintRule, RegExp]> = [
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ['bearer', /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}/i],
  ['tempauth', /tempauth/i],
  ['key-material', /-----BEGIN/],
  ['token-field', /\b(access_token|refresh_token|client_assertion|client_secret)\b/],
];
const ALLOWED_HOSTS = new Set(['graph.microsoft.com', 'replay.invalid']);
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const PLACEHOLDER = /^r\d+$/;

export class CassetteLintError extends Error {
  constructor(readonly findings: LintFinding[]) {
    super(`The cassette failed its credential check:\n${findings.map((f) => `  ${f.rule} at ${f.where}`).join('\n')}`);
    this.name = 'CassetteLintError';
  }
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** Exactly {"error":{"code":"<string>"}} or {"error":{}}. */
function isReducedError(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    const error = (parsed as { error?: unknown }).error;
    if (keys.length !== 1 || keys[0] !== 'error' || !error || typeof error !== 'object' || Array.isArray(error)) return false;
    const inner = Object.entries(error);
    return inner.length === 0 || (inner.length === 1 && inner[0][0] === 'code' && typeof inner[0][1] === 'string');
  } catch {
    return false;
  }
}

export function lintCassette(data: CassetteData): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (rule: LintRule, where: string) => findings.push({ rule, where });
  const text = (value: string, where: string) => {
    for (const [rule, pattern] of TEXT_RULES) if (pattern.test(value)) add(rule, where);
  };
  const paging = (value: string, where: string) => {
    if (pagingValues(value).some((token) => !PLACEHOLDER.test(token))) add('paging-token', where);
  };
  const allowedHeaders = new Set<string>(ALLOWED_RESPONSE_HEADERS);

  data.interactions.forEach((interaction, index) => {
    const at = `interactions[${index}]`;

    const host = hostOf(interaction.url);
    if (host === null || !ALLOWED_HOSTS.has(host)) add('host', `${at}.url`);
    paging(interaction.url, `${at}.url`);
    text(interaction.url, `${at}.url`);

    for (const [name, value] of Object.entries(interaction.headers)) {
      const where = `${at}.headers.${name}`;
      if (!allowedHeaders.has(name)) add('header', where);
      text(String(value), where);
      if (name === 'location' && hostOf(String(value)) !== 'replay.invalid') add('host', where);
    }

    // An error response never keeps a download body: an HTML error page carries correlation ids.
    if (interaction.status >= 400 && interaction.bodyRef !== undefined) add('error-body', `${at}.bodyRef`);

    if (interaction.body !== undefined) {
      text(interaction.body, `${at}.body`);
      // The independent check of scrub's error-body reduction: Graph's innerError carries request-id,
      // client-request-id and date, and message is free text.
      if (interaction.status >= 400 && !isReducedError(interaction.body)) add('error-body', `${at}.body`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(interaction.body);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object') {
        for (const field of ['@odata.nextLink', '@odata.deltaLink']) {
          const link = (parsed as Record<string, unknown>)[field];
          if (typeof link !== 'string') continue;
          const where = `${at}.body.${field}`;
          if (!link.startsWith(`${GRAPH_ORIGIN}/`)) add('host', where);
          paging(link, where);
        }
      }
    }
  });

  // A bodies/ entry that decodes as strict UTF-8 (a text download) is scanned like a mail body. Binary
  // bodies (a PDF, a DOCX) are not: a scan of compressed bytes proves nothing, and their host and URL
  // are checked through the interaction that references them.
  const strict = new TextDecoder('utf-8', { fatal: true });
  for (const [sha, bytes] of data.bodies) {
    let decoded: string;
    try {
      decoded = strict.decode(bytes);
    } catch {
      continue;
    }
    text(decoded, `bodies/${sha}`);
  }
  text(JSON.stringify(data.manifest), 'manifest');
  return findings;
}
