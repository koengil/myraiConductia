// @vitest-environment node
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SYNTHETIC_CASSETTE_DIR } from '../../scripts/m365/build-synthetic-cassette';
import { createFakeTenant, fakeTenantSources, FAKE_JWT } from '../../scripts/m365/cassette/fakeTenant';
import { CASSETTE_FORMAT, readCassette, saveCassette, type CassetteData, type Interaction } from '../../scripts/m365/cassette/format';
import { CassetteLintError, lintCassette } from '../../scripts/m365/cassette/lint';
import { loadCassette } from '../../scripts/m365/cassette/replayFetch';
import { pagingValues } from '../../scripts/m365/cassette/paging';
import { recordSources } from '../../scripts/m365/cassette/record';
import type { RawInteraction } from '../../scripts/m365/cassette/recordFetch';
import { scrub } from '../../scripts/m365/cassette/scrub';

const FIXED = '2026-09-29T00:00:00.000Z';
const G = 'https://graph.microsoft.com/v1.0';

const record = async () => {
  const fake = createFakeTenant();
  const recorded = await recordSources({
    http: { getToken: async () => 'token', fetchImpl: fake.fetch, sleep: async () => undefined },
    sources: fakeTenantSources(),
    recordedAt: FIXED,
  });
  return { fake, ...recorded };
};

/** Cassette data built straight from interactions, as if scrub had been bypassed. */
const bypass = (...interactions: Interaction[]): CassetteData => ({
  manifest: { format: CASSETTE_FORMAT, recordedAt: FIXED, sources: [], interactions: interactions.length, bodies: {} },
  interactions,
  bodies: new Map(),
});

const ok = (over: Partial<Interaction> = {}): Interaction => ({
  method: 'GET',
  url: `${G}/x`,
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"value":[]}',
  ...over,
});

const newDir = () => join(mkdtempSync(join(tmpdir(), 'cassette-scrub-')), 'c');

describe('scrub: the fake tenant seeds every secret class, none reaches the cassette', () => {
  it('stores none of the seeded secrets, and the lint agrees', async () => {
    const { fake, cassette, droppedHeaders } = await record();

    const stored = JSON.stringify([cassette.manifest, cassette.interactions]);
    for (const secret of [FAKE_JWT, 'tempauth', 'x-ms-throttle-scope', 'request-id', 'https://bank.sharepoint.com', 'x-canary-authorization', 'innerError', 'The specified object was not found']) {
      expect(stored).not.toContain(secret);
    }
    const rawTokens = pagingValues(fake.requests.join('\n'));
    expect(rawTokens.length).toBeGreaterThan(0);
    for (const token of rawTokens) expect(stored).not.toContain(token);
    const links = cassette.interactions.map((i) => `${i.url} ${i.body ?? ''}`).join('\n');
    expect(pagingValues(links).length).toBeGreaterThan(0);
    for (const token of pagingValues(links)) expect(token).toMatch(/^r\d+$/);

    expect(lintCassette(cassette)).toEqual([]);
    expect(droppedHeaders).toEqual(expect.arrayContaining(['request-id', 'x-ms-throttle-scope', 'x-canary-authorization']));
  });

  it('collapses the throttled request to its 200 and keeps no 429', async () => {
    const { fake, cassette } = await record();
    expect(fake.requests.length).toBeGreaterThan(cassette.interactions.length);
    expect(cassette.interactions.filter((i) => i.status === 429)).toEqual([]);
    // Storm's first inbox delta was asked for twice (a 429, then the retry) and is stored once.
    const first = fake.requests.filter((u) => u.includes('storm.duncan') && u.includes('inbox') && /\/messages\/delta\?(?!.*token)/.test(u));
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(1);
    expect(cassette.interactions.filter((i) => i.url === first[0]).map((i) => i.status)).toEqual([200]);
  });
});

describe('lintCassette: each class is caught when scrub is bypassed', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJmYWtlIn0.c2lnbmF0dXJlLWJ5dGVz';
  const seeded: Array<[string, Interaction, string[]]> = [
    ['a Bearer JWT header', ok({ headers: { 'x-canary-authorization': `Bearer ${jwt}` } as never }), ['header', 'jwt', 'bearer']],
    ['tempauth in a location', ok({ status: 302, headers: { location: 'https://replay.invalid/x?tempauth=abc' } }), ['tempauth']],
    ['an opaque $skiptoken in a URL', ok({ url: `${G}/y?$skiptoken=AbCdEf0123456789` }), ['paging-token']],
    ['a SharePoint request URL', ok({ url: 'https://bank.sharepoint.com/_layouts/15/download.aspx?UniqueId=a' }), ['host']],
    ['a raw location host', ok({ status: 302, headers: { location: 'https://bank.sharepoint.com/a' } }), ['host']],
    ['key material in a body', ok({ body: '{"note":"-----BEGIN PRIVATE KEY-----"}' }), ['key-material']],
    ['an access_token field in a body', ok({ body: '{"access_token":"x"}' }), ['token-field']],
    ['an error body that kept its innerError', ok({ status: 404, body: '{"error":{"code":"ErrorItemNotFound","innerError":{"date":"2026-09-29T10:00:00","request-id":"a"}}}' }), ['error-body']],
    ['an error body that kept its message', ok({ status: 500, body: '{"error":{"code":"x","message":"free text"}}' }), ['error-body']],
    ['an error body that is not JSON', ok({ status: 404, body: 'Not Found' }), ['error-body']],
    ['a download body kept on an error response', ok({ status: 404, body: undefined, bodyRef: 'a'.repeat(64), headers: { 'content-type': 'text/html' } }), ['error-body']],
    ['a foreign origin in a body link', ok({ body: '{"@odata.nextLink":"https://evil.example/x?$skiptoken=r1"}' }), ['host']],
    ['a raw token in a body link', ok({ body: `{"@odata.deltaLink":"${G}/x?$deltatoken=AbCdEf0123456789"}` }), ['paging-token']],
  ];

  it.each(seeded)('%s', (_name, interaction, rules) => {
    const found = lintCassette(bypass(interaction)).map((f) => f.rule);
    for (const rule of rules) expect(found).toContain(rule);
  });

  it('accepts the two reduced error shapes, and applies the rule to errors only', () => {
    expect(lintCassette(bypass(ok({ status: 404, body: '{"error":{"code":"ErrorItemNotFound"}}' }), ok({ url: `${G}/z`, status: 500, body: '{"error":{}}' })))).toEqual([]);
    expect(lintCassette(bypass(ok({ body: '{"error":{"code":"x","message":"a payload may say this"}}' })))).toEqual([]);
  });

  it('scans a bodies/ entry that decodes as UTF-8, and names it by path', () => {
    const data = bypass(ok());
    data.bodies.set('ab12', new TextEncoder().encode('note\n-----BEGIN PRIVATE KEY-----\n'));
    data.bodies.set('cd34', new Uint8Array([0xff, 0xfe, 0x00, 0x2d, 0x2d, 0x2d, 0x2d, 0x2d, 0x42])); // not UTF-8: binary, unscanned
    expect(lintCassette(data)).toEqual([{ rule: 'key-material', where: 'bodies/ab12' }]);
  });

  it('finds a credential in the manifest', () => {
    const data = bypass(ok());
    data.manifest.sources = [{ kind: 'mailbox', address: 'a@bank.example?access_token=1' }];
    expect(lintCassette(data)).toContainEqual({ rule: 'token-field', where: 'manifest' });
  });

  it('does not block ordinary words a synthetic email could hold', () => {
    const body = JSON.stringify({ value: [{ subject: 'Bearer bonds and the token economy', bodyPreview: 'the client secret sauce, an access token of goodwill' }] });
    expect(lintCassette(bypass(ok({ body })))).toEqual([]);
  });

  it('never echoes a seeded value: not in a finding, not in the error', () => {
    const secrets = [jwt, 'AbCdEf0123456789', 'tempauth=abc', 'bank.sharepoint.com'];
    const data = bypass(
      ok({ headers: { 'x-canary-authorization': `Bearer ${jwt}` } as never }),
      ok({ url: `${G}/y?$skiptoken=AbCdEf0123456789` }),
      ok({ status: 302, headers: { location: 'https://bank.sharepoint.com/a?tempauth=abc' } }),
    );
    const findings = lintCassette(data);
    expect(findings.length).toBeGreaterThan(0);
    const printed = JSON.stringify(findings) + new CassetteLintError(findings).message;
    for (const secret of secrets) expect(printed).not.toContain(secret);
  });
});

describe('scrub: non-JSON error bodies', () => {
  const meta = { sources: [], recordedAt: FIXED };
  const html = '<html><body>Sorry, something went wrong. Correlation ID: 4f0c2a7e-aaaa-bbbb-cccc-123456789abc</body></html>';
  const page = (status: number, headers: Record<string, string>, body: string, url = `${G}/sites/s/drives`): RawInteraction => ({
    method: 'GET',
    url,
    status,
    headers,
    bytes: new TextEncoder().encode(body),
  });

  it.each([404, 500])('drops the body and its length from a %i HTML page: nothing under bodies/, no bodyRef', (status) => {
    const { cassette } = scrub(
      [page(status, { 'content-type': 'text/html', 'content-length': String(html.length), 'request-id': 'r' }, html)],
      meta,
    );
    const [only] = cassette.interactions;
    expect(only.status).toBe(status);
    expect(only.body).toBeUndefined();
    expect(only.bodyRef).toBeUndefined();
    expect(only.headers['content-length']).toBeUndefined();
    expect(only.headers['content-type']).toBe('text/html');
    expect(cassette.bodies.size).toBe(0);
    expect(cassette.manifest.bodies).toEqual({});
    expect(JSON.stringify(cassette)).not.toContain('Correlation');
    expect(lintCassette(cassette)).toEqual([]);
  });

  it('drops a JSON-typed error body that is not JSON, and a text/plain one', () => {
    const { cassette } = scrub(
      [
        page(404, { 'content-type': 'application/json' }, 'Not Found <request-id abc>', `${G}/a`),
        page(404, { 'content-type': 'text/plain' }, 'nothing here for alex@bank.example', `${G}/b`),
        page(404, {}, 'no content type at all', `${G}/c`),
      ],
      meta,
    );
    for (const interaction of cassette.interactions) {
      expect(interaction.body).toBeUndefined();
      expect(interaction.bodyRef).toBeUndefined();
    }
    expect(cassette.bodies.size).toBe(0);
    expect(JSON.stringify(cassette)).not.toMatch(/request-id|bank\.example|no content type/);
    expect(lintCassette(cassette)).toEqual([]);
  });

  it('keeps a successful non-JSON download and still reduces a JSON error', () => {
    const { cassette } = scrub(
      [
        page(200, { 'content-type': 'application/pdf' }, '%PDF-1.4', 'https://graph.microsoft.com/v1.0/drives/d/items/i/content'),
        page(404, { 'content-type': 'application/json' }, '{"error":{"code":"ErrorItemNotFound","message":"m"}}', `${G}/gone`),
      ],
      meta,
    );
    expect(cassette.interactions[0].bodyRef).toBeDefined();
    expect(cassette.interactions[1].body).toBe('{"error":{"code":"ErrorItemNotFound"}}');
  });

  it('does not treat a per-call correlation id in an HTML error page as a divergence', () => {
    const at = (id: string) => page(404, { 'content-type': 'text/html' }, html.replace('4f0c2a7e', id));
    const { cassette } = scrub([at('11111111'), at('22222222')], meta);
    expect(cassette.interactions).toHaveLength(1);
  });

  it('lint refuses a bodyRef on an error response written by hand, naming the rule and place only', () => {
    const data = bypass(ok({ status: 404, body: undefined, bodyRef: 'a'.repeat(64) }));
    expect(lintCassette(data)).toContainEqual({ rule: 'error-body', where: 'interactions[0].bodyRef' });
    // ...and a bodyRef on a success is fine.
    expect(lintCassette(bypass(ok({ body: undefined, bodyRef: 'a'.repeat(64) })))).toEqual([]);
  });
});

describe('scrub: paging tokens', () => {
  const raw = (url: string, body = '{"value":[]}'): RawInteraction => ({
    method: 'GET',
    url,
    status: 200,
    headers: { 'content-type': 'application/json' },
    bytes: new TextEncoder().encode(body),
  });
  const meta = { sources: [], recordedAt: FIXED };

  it('rewrites every spelling: %24skiptoken, ?token= and delta(token=…)', () => {
    const { cassette } = scrub(
      [raw(`${G}/a?%24skiptoken=AAA111`), raw(`${G}/b?token=BBB222`), raw(`${G}/drives/d/root/delta(token='CCC333')`)],
      meta,
    );
    expect(cassette.interactions.map((i) => i.url)).toEqual([
      `${G}/a?%24skiptoken=r1`,
      `${G}/b?token=r2`,
      `${G}/drives/d/root/delta(token='r3')`,
    ]);
  });

  it('maps one raw token to one placeholder, in a body link and in the request it becomes', () => {
    const next = `${G}/m/delta?$skiptoken=TOKEN-ONE`;
    const { cassette } = scrub(
      [raw(`${G}/m/delta`, JSON.stringify({ value: [], '@odata.nextLink': next })), raw(next, JSON.stringify({ value: [], '@odata.deltaLink': `${G}/m/delta?$deltatoken=TOKEN-TWO` }))],
      meta,
    );
    const [first, second] = cassette.interactions;
    expect(JSON.parse(first.body!)['@odata.nextLink']).toBe(`${G}/m/delta?$skiptoken=r1`);
    expect(second.url).toBe(`${G}/m/delta?$skiptoken=r1`);
    expect(JSON.parse(second.body!)['@odata.deltaLink']).toBe(`${G}/m/delta?$deltatoken=r2`);
  });

  it('normalizes a body link the way graphUrl does, so it still matches its request', () => {
    const link = `https://Graph.Microsoft.com/v1.0/m/delta?$skiptoken=TOKEN-ONE&$select=a b`;
    const request = new URL(link).toString(); // what graphFetch sends
    const { cassette } = scrub([raw(`${G}/m/delta`, JSON.stringify({ value: [], '@odata.nextLink': link })), raw(request)], meta);
    const [first, second] = cassette.interactions;
    expect(JSON.parse(first.body!)['@odata.nextLink']).toBe(second.url);
    expect(second.url).toContain('$skiptoken=r1');
  });
});

describe('saveCassette: refuses a dirty cassette', () => {
  it('throws the lint error and leaves no directory', () => {
    const dir = newDir();
    expect(() => saveCassette(dir, bypass(ok({ url: 'https://bank.sharepoint.com/a' })))).toThrow(CassetteLintError);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('the committed synthetic cassette', () => {
  it('is caught when a header is added to a temp copy, and the committed files are untouched', () => {
    const before = readFileSync(join(SYNTHETIC_CASSETTE_DIR, 'interactions.jsonl'), 'utf8');
    const copy = newDir();
    cpSync(SYNTHETIC_CASSETTE_DIR, copy, { recursive: true });
    expect(lintCassette(readCassette(copy))).toEqual([]);

    const lines = readFileSync(join(copy, 'interactions.jsonl'), 'utf8').split('\n');
    const first = JSON.parse(lines[0]) as Interaction;
    (first.headers as Record<string, string>)['x-ms-throttle-scope'] = 'Tenant_Application/ReadOnly/a/b';
    lines[0] = JSON.stringify(first);
    writeFileSync(join(copy, 'interactions.jsonl'), lines.join('\n'));

    expect(lintCassette(readCassette(copy))).toContainEqual({ rule: 'header', where: 'interactions[0].headers.x-ms-throttle-scope' });
    // The loader refuses the same copy earlier, at the digest, and names the file.
    expect(() => loadCassette(copy)).toThrow('cassette file interactions.jsonl');
    expect(readFileSync(join(SYNTHETIC_CASSETTE_DIR, 'interactions.jsonl'), 'utf8')).toBe(before);
  });
});
