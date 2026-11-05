// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createFakeTenant, fakeTenantSources, FAKE_SITE_ADDRESS } from '../../scripts/m365/cassette/fakeTenant';
import { ALLOWED_RESPONSE_HEADERS, CASSETTE_FORMAT, readCassette, saveCassette, type CassetteData } from '../../scripts/m365/cassette/format';
import { maskTokens } from '../../scripts/m365/cassette/paging';
import { readBackfillThenDelta, recordSources, sourceRow } from '../../scripts/m365/cassette/record';
import { CassetteMissError, loadCassette, redactedRequest, replayFetch, replayReaderFor } from '../../scripts/m365/cassette/replayFetch';
import { scrub, ScrubDivergenceError } from '../../scripts/m365/cassette/scrub';
import { createRecorder, type RawInteraction } from '../../scripts/m365/cassette/recordFetch';
import { RecorderRefusal } from '../../scripts/m365/cassette/refusal';
import { SOURCE_KIND } from '../../src/lib/constants/discovery';
import type { GraphHttpOptions } from '../../src/lib/graph/http';
import type { ExtractFn } from '../../src/lib/graph/reader/drive';
import { graphContentSourceOver, loadFixtureCorpus, type ContentSource, type SourceItemPage } from '../../src/lib/mailboxAccess/readers';

const FIXED = '2026-09-29T00:00:00.000Z';

const http = (fetchImpl: typeof fetch): GraphHttpOptions => ({
  getToken: async () => 'token',
  fetchImpl,
  sleep: async () => undefined,
});

// Both sides read with the same stub, so the unit suite does not spawn the sandboxed parser.
const extract: ExtractFn = async (bytes) => ({ ok: true, text: Buffer.from(bytes).toString('latin1') });

// A replayed checkpoint carries r<n> where the direct read carries the tenant's raw token. Everything
// else is compared exactly.
const masked = (read: { backfill: SourceItemPage[]; delta: SourceItemPage[] }) => {
  const mask = (page: SourceItemPage) => ({ ...page, nextCheckpoint: page.nextCheckpoint ? maskTokens(page.nextCheckpoint) : page.nextCheckpoint });
  return { backfill: read.backfill.map(mask), delta: read.delta.map(mask) };
};

const newDir = () => join(mkdtempSync(join(tmpdir(), 'cassette-')), 'c');

async function record() {
  return recordSources({ http: http(createFakeTenant().fetch), sources: fakeTenantSources(), recordedAt: FIXED });
}

describe('graph cassette: round trip', () => {
  it('replays every page of every source exactly as the fake Graph served it', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const cassette = loadCassette(dir);
    const replay = replayReaderFor(cassette, { extract });

    const sources = fakeTenantSources();
    expect(sources).toHaveLength(4);
    for (const [index, source] of sources.entries()) {
      const direct = await readBackfillThenDelta(
        graphContentSourceOver(source.kind, { http: http(createFakeTenant().fetch), extract }),
        sourceRow(source, index),
      );
      const replayed = await readBackfillThenDelta(
        replay({ ...sourceRow(source, index), backfillCompletedAt: null }),
        sourceRow(source, index),
      );
      expect(masked(replayed)).toEqual(masked(direct));
      const pages = replayed.backfill;
      const read = source.address === FAKE_SITE_ADDRESS ? pages.flatMap((p) => p.documents ?? []) : pages.flatMap((p) => p.items);
      expect(read.length).toBeGreaterThan(0);
    }
    expect(cassette.fetch.misses).toEqual([]);
    // Every recorded interaction was asked for (counted by interaction: the printed lines are redacted).
    expect(cassette.fetch.unrequested()).toBe(0);
  });

  it('answers an unrecorded URL with a miss that names the path and query, not the host or an unknown mailbox', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const cassette = loadCassette(dir);

    const url = 'https://graph.microsoft.com/v1.0/users/nobody%40bank.example/mailFolders?$top=100';
    const error = await cassette.fetch(url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CassetteMissError);
    expect((error as Error).message).toContain('/v1.0/users/<mailbox ?>/mailFolders?$top=100');
    expect((error as Error).message).not.toMatch(/bank\.example/i);
    expect((error as Error).message).not.toContain('graph.microsoft.com');
    expect(cassette.fetch.misses).toHaveLength(1);
  });

  it('redacts a known source address from a miss, in every form, keeping the source index', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const cassette = loadCassette(dir);

    const address = fakeTenantSources()[0].address; // mailbox 0
    const urls = [
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(address)}/mailFolders?$top=7`,
      `https://graph.microsoft.com/v1.0/users/${address}/mailFolders?$top=7`,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(address.toUpperCase())}/mailFolders?$top=7`,
    ];
    for (const url of urls) {
      const error = (await cassette.fetch(url).catch((e: unknown) => e)) as CassetteMissError;
      expect(error).toBeInstanceOf(CassetteMissError);
      expect(error.message).toContain('<mailbox 0>');
      expect(error.message).not.toMatch(/bank\.example/i);
      expect(error.url).toBe(url); // kept for tests, never printed
    }
    // A $filter value is redacted whole (it can hold anything), so the address is gone with it.
    const filtered = (await cassette.fetch(`https://graph.microsoft.com/v1.0/x?$filter=from/emailAddress/address eq '${address}'`).catch((e: unknown) => e)) as Error;
    expect(filtered.message).toContain('/v1.0/x?$filter=<redacted>');
    expect(filtered.message).not.toMatch(/bank\.example/i);
    const forms = [
      [`https://graph.microsoft.com/v1.0/users('stranger@bank.example')/messages?$top=1`, `users('<mailbox ?>')/messages`],
      [`https://graph.microsoft.com/v1.0/sites/other.sharepoint.com,guid,guid/drives?$select=id`, `/sites/<site ?>/drives`],
      [`https://graph.microsoft.com/v1.0/sites/other.sharepoint.com(x)?$select=id`, `/sites/<site ?>(x)`],
    ];
    for (const [url, expected] of forms) {
      const error = (await cassette.fetch(url).catch((e: unknown) => e)) as Error;
      expect(error.message).toContain(expected);
      expect(error.message).not.toMatch(/stranger|other\.sharepoint/);
    }
    const site = fakeTenantSources().findIndex((s) => s.address === FAKE_SITE_ADDRESS);
    const siteError = (await cassette.fetch(`https://graph.microsoft.com/v1.0/sites/${FAKE_SITE_ADDRESS}?$select=id&x=1`).catch((e: unknown) => e)) as Error;
    expect(siteError.message).toContain(`<site ${site}>`);
    expect(siteError.message).not.toContain('sharepoint.com');
  });

  it('never prints a query value that could be a token, an address or a subject, and keeps the parameter names', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const cassette = loadCassette(dir);

    const RAW = 'RAWTOKEN0123abcdEFGH';
    const G = 'https://graph.microsoft.com/v1.0/users/nobody%40bank.example';
    const urls = [
      `${G}/messages/delta?$skiptoken=${RAW}`,
      `${G}/messages/delta?%24skiptoken=${RAW}`,
      `${G}/messages/delta?$deltatoken=${RAW}`,
      `${G}/messages/delta?token=${RAW}`,
      `https://graph.microsoft.com/v1.0/drives/d/items/i/content?tempauth=${RAW}`,
      `https://graph.microsoft.com/v1.0/drives/d/root/delta(token='${RAW}')`,
      `https://graph.microsoft.com/v1.0/drives/d/root/delta(token=%27${RAW}%27)`,
      `${G}/messages?madeUpParam=${RAW}&$top=50`,
      `${G}/messages?$select=${RAW}@bank.example`,
      `${G}/messages?$search="${RAW}"`,
    ];
    for (const url of urls) {
      const error = (await cassette.fetch(url).catch((e: unknown) => e)) as CassetteMissError;
      expect(error).toBeInstanceOf(CassetteMissError);
      expect(error.message).not.toContain(RAW);
      expect(error.message).not.toContain('bank.example');
      expect(error.url).toBe(url); // kept for tests, never printed
    }
    for (const miss of cassette.fetch.misses) expect(miss).not.toContain(RAW); // the list a failed assertion prints

    const message = async (url: string) => ((await cassette.fetch(url).catch((e: unknown) => e)) as Error).message;
    // Names stay, values go.
    expect(await message(`${G}/messages/delta?$skiptoken=${RAW}`)).toContain('/messages/delta?$skiptoken=<redacted>');
    expect(await message(`${G}/messages/delta?%24deltatoken=${RAW}`)).toContain('?%24deltatoken=<redacted>');
    expect(await message(`https://graph.microsoft.com/v1.0/x?tempauth=${RAW}&madeUpParam=1`)).toContain('?tempauth=<redacted>&madeUpParam=<redacted>');
    expect(await message(`https://graph.microsoft.com/v1.0/drives/d/root/delta(token='${RAW}')`)).toContain('delta(token=<redacted>)');
    // The harmless OData parameters the readers send stay readable: a count and property names.
    expect(await message(`${G}/mailFolders?$select=id,childFolderCount&$top=100`)).toContain('/mailFolders?$select=id,childFolderCount&$top=100');
    // ...but only in that shape.
    expect(await message(`${G}/mailFolders?$top=${RAW}`)).toContain('$top=<redacted>');
  });

  it('prints a query parameter with no value as <param>, so a bare token is never shown', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const cassette = loadCassette(dir);

    const RAW = 'BARETOKEN0123abcdEFGH';
    const G = 'https://graph.microsoft.com/v1.0';
    const message = async (url: string) => ((await cassette.fetch(url).catch((e: unknown) => e)) as Error).message;
    expect(await message(`${G}/x?${RAW}`)).toContain('/v1.0/x?<param>.');
    expect(await message(`${G}/x?${RAW}&$top=5&${RAW}2`)).toContain('/v1.0/x?<param>&$top=5&<param>.');
    expect(await message(`${G}/x?$count`)).toContain('/v1.0/x?<param>.');
    for (const line of cassette.fetch.misses) expect(line).not.toContain('BARETOKEN');
    for (const line of cassette.fetch.requests) expect(line).not.toContain('BARETOKEN');
  });

  it('redacts a path segment over 40 characters unless it is a Graph literal, keeping the labels and the delta form', () => {
    const G = 'https://graph.microsoft.com/v1.0';
    const LONG = 'AAMkAGI2THVSAAA'.repeat(4); // a 60-character folder id
    const sources = fakeTenantSources();
    const mailbox = sources[0].address;

    expect(redactedRequest(`${G}/users/${encodeURIComponent(mailbox)}/mailFolders/${LONG}/messages/delta?$select=id`, sources)).toBe(
      '/v1.0/users/<mailbox 0>/mailFolders/<segment>/messages/delta?$select=id',
    );
    // 40 stays, 41 goes: an id short enough to read is what tells an engineer which request drifted.
    expect(redactedRequest(`${G}/drives/${'d'.repeat(40)}/items/${'i'.repeat(41)}/content`)).toBe(`/v1.0/drives/${'d'.repeat(40)}/items/<segment>/content`);
    // Every literal the readers send stays, in any case, whatever surrounds it.
    expect(redactedRequest(`${G}/sites/x/drives?$select=id,name`)).toBe('/v1.0/sites/<site ?>/drives?$select=id,name');
    expect(redactedRequest(`${G}/drives/D/root/delta?$select=id`)).toBe('/v1.0/drives/D/root/delta?$select=id');
    expect(redactedRequest(`${G}/drives/D/items/I/children`)).toBe('/v1.0/drives/D/items/I/children');
    expect(redactedRequest(`${G}/users/u/MAILFOLDERS/deleteditems?$select=id`)).toBe('/v1.0/users/<mailbox ?>/MAILFOLDERS/deleteditems?$select=id');
    expect(redactedRequest(`${G}/users/u/mailFolders/${LONG}/childFolders?$select=id,childFolderCount&$top=100`)).toBe(
      '/v1.0/users/<mailbox ?>/mailFolders/<segment>/childFolders?$select=id,childFolderCount&$top=100',
    );
    // An unknown address longer than 40 keeps its label, not <segment>; the delta cursor keeps its form.
    expect(redactedRequest(`${G}/users/${'z'.repeat(50)}%40bank.example/messages`)).toBe('/v1.0/users/<mailbox ?>/messages');
    expect(redactedRequest(`${G}/drives/D/root/delta(token='${LONG}')`)).toBe('/v1.0/drives/D/root/delta(token=<redacted>)');
    // The query is not a path: its own rules apply (a name over 64 characters is <param>).
    expect(redactedRequest(`${G}/x?$top=5&${'q'.repeat(70)}=1`)).toBe('/v1.0/x?$top=5&<param>=<redacted>');
  });

  it('records the requests in the redacted form too, and counts what was never asked for', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const cassette = loadCassette(dir);
    const recordedUrl = cassette.interactions.find((i) => i.url.includes('/mailFolders?'))!.url;

    expect(cassette.fetch.unrequested()).toBe(cassette.interactions.length);
    await cassette.fetch(recordedUrl);
    await cassette.fetch('https://graph.microsoft.com/v1.0/users/nobody%40bank.example/x?$skiptoken=RAWTOKEN0123abcdEFGH').catch(() => undefined);
    expect(cassette.fetch.unrequested()).toBe(cassette.interactions.length - 1);
    expect(cassette.fetch.requests).toHaveLength(2);
    expect(cassette.fetch.misses).toHaveLength(1);
    expect(cassette.fetch.requests[0]).toBe(`GET ${redactedRequest(recordedUrl, cassette.manifest.sources)}`);
    expect(cassette.fetch.requests[1]).toBe('GET /v1.0/users/<mailbox ?>/x?$skiptoken=<redacted>');
    for (const line of cassette.fetch.requests) {
      expect(line).not.toMatch(/graph\.microsoft\.com|bank\.example|RAWTOKEN|^GET https?:/);
    }
    // Asking twice is still one interaction.
    await cassette.fetch(recordedUrl);
    expect(cassette.fetch.unrequested()).toBe(cassette.interactions.length - 1);
  });

  it('stores no header outside the allowlist and no credential', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);

    for (const interaction of recorded.cassette.interactions) {
      for (const name of Object.keys(interaction.headers)) {
        expect(ALLOWED_RESPONSE_HEADERS as readonly string[]).toContain(name);
      }
    }
    const text = readFileSync(join(dir, 'interactions.jsonl'), 'utf8');
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toContain('Bearer token');
  });

  it('refuses to overwrite an existing cassette directory', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    expect(() => saveCassette(dir, recorded.cassette)).toThrow(/EEXIST/);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
  });
});

describe('graph cassette: a body the cassette does not hold', () => {
  const data = (over: Partial<CassetteData['interactions'][number]>): CassetteData => ({
    manifest: { format: CASSETTE_FORMAT, recordedAt: FIXED, sources: [], interactions: 1, bodies: {} },
    interactions: [{ method: 'GET', url: 'https://replay.invalid/content/1', status: 200, headers: {}, ...over }],
    bodies: new Map(),
  });

  it('throws instead of replaying an empty 200 when a bodyRef is not in bodies', async () => {
    const fetchImpl = replayFetch(data({ bodyRef: 'a'.repeat(64) }));
    await expect(fetchImpl('https://replay.invalid/content/1')).rejects.toThrow(/holds no body/);
  });

  it('still replays a bodyless interaction (a 302, an empty 200) and one that has its body', async () => {
    expect((await replayFetch(data({ status: 200 }))('https://replay.invalid/content/1')).status).toBe(200);
    const withBody = data({ bodyRef: 'b'.repeat(64) });
    withBody.bodies.set('b'.repeat(64), new TextEncoder().encode('hello'));
    expect(await (await replayFetch(withBody)('https://replay.invalid/content/1')).text()).toBe('hello');
  });
});

describe('graph cassette: manifest body keys', () => {
  it('refuses a body key that is not a sha256, without reading the path it names', async () => {
    const recorded = await record();
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const key of ['../manifest.json', '..%2Fmanifest.json', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '/x', '']) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, bodies: { [key]: 1 } }));
      expect(() => readCassette(dir), `key ${JSON.stringify(key)}`).toThrow(/key is not a sha256/);
    }
  });
});

describe('graph cassette: downloads', () => {
  const site = { kind: 'sharepoint_site' as const, address: FAKE_SITE_ADDRESS };

  it('reads the library as documents and skips, and never asks for the image', async () => {
    const fake = createFakeTenant();
    const recorded = await recordSources({ http: http(fake.fetch), sources: [site], recordedAt: FIXED });
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const cassette = loadCassette(dir);

    const replayed = await readBackfillThenDelta(replayReaderFor(cassette, { extract })({ ...sourceRow(site, 0), backfillCompletedAt: null }), sourceRow(site, 0));
    const documents = replayed.backfill.flatMap((p) => p.documents ?? []);
    // The teaser appears twice in the delta feed (Graph allows it), and is read once per appearance.
    expect(documents.map((d) => [d.providerItemId, d.drivePath])).toEqual([
      ['falcon-teaser', '/Falcon/Falcon teaser.pdf'],
      ['canteen-menu', 'Canteen menu.txt'],
      ['falcon-teaser', '/Falcon/Falcon teaser.pdf'],
    ]);
    expect(replayed.backfill.flatMap((p) => p.skipped ?? []).map((s) => [s.providerItemId, s.reason])).toEqual([['logo', 'image_only']]);

    expect(fake.requests.filter((u) => u.includes('/items/logo/content'))).toEqual([]);
    expect(cassette.interactions.filter((i) => i.url.includes('/items/logo/content'))).toEqual([]);
    expect(cassette.fetch.misses).toEqual([]);
    // Every request off Graph went to the placeholder host. The printed lines carry no host, so a Graph request
    // is the one under /v1.0/ and the rest are the download hops, which the cassette stores under replay.invalid.
    const off = cassette.fetch.requests.map((k) => k.split(' ')[1]).filter((path) => !path.startsWith('/v1.0/'));
    expect(off.length).toBeGreaterThan(0);
    for (const path of off) expect(path).toMatch(/^\/content\/\d+$/);
    const hops = cassette.interactions.map((i) => i.url).filter((u) => !u.startsWith('https://graph.microsoft.com/'));
    expect(hops.length).toBeGreaterThan(0);
    for (const url of hops) expect(url).toMatch(/^https:\/\/replay\.invalid\/content\/\d+$/);
  });

  it('stores no SharePoint host: every download hop goes to the placeholder host, bytes by hash', async () => {
    const recorded = await recordSources({ http: http(createFakeTenant().fetch), sources: [site], recordedAt: FIXED });
    const { interactions, bodies, manifest } = recorded.cassette;

    expect(JSON.stringify([interactions, manifest])).not.toMatch(/https:\/\/bank\.sharepoint\.com/);
    const redirects = interactions.filter((i) => i.status === 302);
    expect(redirects.map((i) => i.headers.location).sort()).toEqual([
      'https://replay.invalid/content/1',
      'https://replay.invalid/content/2',
    ]);
    const hops = interactions.filter((i) => i.url.startsWith('https://replay.invalid/'));
    expect(hops.map((i) => i.url).sort()).toEqual(['https://replay.invalid/content/1', 'https://replay.invalid/content/2']);
    for (const hop of hops) {
      expect(hop.bodyRef).toBeDefined();
      expect(hop.body).toBeUndefined();
      expect(hop.headers['content-length']).toBe(String(bodies.get(hop.bodyRef!)!.byteLength));
    }
    expect(Object.keys(manifest.bodies)).toEqual([...Object.keys(manifest.bodies)].sort());
    expect(manifest.bodies).toEqual(Object.fromEntries([...bodies].map(([sha, bytes]) => [sha, bytes.byteLength])));
  });

  it('drops the orphan hop of a driveItem the delta feed repeated, and counts it', async () => {
    const fake = createFakeTenant();
    const recorded = await recordSources({ http: http(fake.fetch), sources: [site], recordedAt: FIXED });
    const { interactions } = recorded.cassette;

    // The fake served the teaser's content twice, each with its own Location.
    const contentRequests = fake.requests.filter((u) => u.includes('/items/falcon-teaser/content'));
    expect(contentRequests).toHaveLength(2);
    const hopRequests = fake.requests.filter((u) => u.startsWith('https://bank.sharepoint.com/') && u.includes('UniqueId=falcon-teaser'));
    expect(hopRequests).toHaveLength(2);
    expect(new Set(hopRequests).size).toBe(2);

    // One /content interaction, one matching hop, one orphan dropped.
    expect(interactions.filter((i) => i.url.includes('/items/falcon-teaser/content'))).toHaveLength(1);
    const teaser = interactions.find((i) => i.url.includes('/items/falcon-teaser/content'))!;
    expect(interactions.filter((i) => i.url === teaser.headers.location)).toHaveLength(1);
    expect(recorded.orphansDropped).toBe(1);
  });

  it('records the repeated teaser without a divergence, and its second hop carries the same bytes', async () => {
    await expect(recordSources({ http: http(createFakeTenant().fetch), sources: [site], recordedAt: FIXED })).resolves.toBeDefined();
  });

  it('refuses a cassette whose body file is missing or the wrong size', async () => {
    const recorded = await recordSources({ http: http(createFakeTenant().fetch), sources: [site], recordedAt: FIXED });
    const dir = newDir();
    saveCassette(dir, recorded.cassette);
    const [sha] = [...recorded.cassette.bodies.keys()];

    writeFileSync(join(dir, 'bodies', sha), 'x');
    expect(() => loadCassette(dir)).toThrow(`bodies/${sha}`);
    rmSync(join(dir, 'bodies', sha));
    expect(() => loadCassette(dir)).toThrow(/is missing/);
  });
});

describe('scrub: collapsing retries', () => {
  const raw = (status: number, url = 'https://graph.microsoft.com/v1.0/x', body = '{"a":1}'): RawInteraction => ({
    method: 'GET',
    url,
    status,
    headers: { 'content-type': 'application/json', 'retry-after': '0', 'request-id': 'abc' },
    bytes: new TextEncoder().encode(body),
  });
  const meta = { sources: [], recordedAt: FIXED };

  it('keeps the last response for a key, at the position the key was first seen', () => {
    const { cassette, droppedHeaders } = scrub(
      [
        raw(429, 'https://graph.microsoft.com/v1.0/x', '{"error":{"code":"TooManyRequests"}}'),
        raw(200, 'https://graph.microsoft.com/v1.0/y'),
        raw(200, 'https://graph.microsoft.com/v1.0/x'),
      ],
      meta,
    );
    expect(cassette.interactions.map((i) => [i.url.split('/').pop(), i.status])).toEqual([
      ['x', 200],
      ['y', 200],
    ]);
    expect(cassette.manifest.interactions).toBe(2);
    expect(droppedHeaders).toEqual(['request-id', 'retry-after']);
  });

  it('keeps a lone final 404', () => {
    const { cassette } = scrub([raw(404, 'https://graph.microsoft.com/v1.0/gone', '{"error":{"code":"ErrorItemNotFound"}}')], meta);
    expect(cassette.interactions).toHaveLength(1);
    expect(cassette.interactions[0].status).toBe(404);
  });

  it('canonicalises JSON and drops its content-length; keeps unparseable JSON as text', () => {
    const { cassette } = scrub(
      [
        { ...raw(200, 'https://graph.microsoft.com/v1.0/a', '{ "a" : 1 }'), headers: { 'content-type': 'application/json', 'content-length': '11' } },
        raw(200, 'https://graph.microsoft.com/v1.0/b', 'not json'),
      ],
      meta,
    );
    expect(cassette.interactions[0].body).toBe('{"a":1}');
    expect(cassette.interactions[0].headers).toEqual({ 'content-type': 'application/json' });
    expect(cassette.interactions[1].body).toBe('not json');
  });
});

describe('scrub: error bodies', () => {
  const meta = { sources: [], recordedAt: FIXED };
  const rawError = (url: string, body: unknown, status = 404): RawInteraction => ({
    method: 'GET',
    url,
    status,
    headers: { 'content-type': 'application/json' },
    bytes: new TextEncoder().encode(JSON.stringify(body)),
  });

  it('reduces a 404 with an innerError to its code', () => {
    const { cassette } = scrub(
      [
        rawError('https://graph.microsoft.com/v1.0/a', {
          error: { code: 'ErrorItemNotFound', message: 'gone', innerError: { date: '2026-09-29T10:00:00', 'request-id': 'r', 'client-request-id': 'c' } },
        }),
      ],
      meta,
    );
    expect(cassette.interactions[0].body).toBe('{"error":{"code":"ErrorItemNotFound"}}');
  });

  it('reduces to {"error":{}} when there is no string code', () => {
    const { cassette } = scrub(
      [rawError('https://graph.microsoft.com/v1.0/a', { error: { message: 'x' } }), rawError('https://graph.microsoft.com/v1.0/b', { error: { code: 7 } }, 500)],
      meta,
    );
    expect(cassette.interactions.map((i) => i.body)).toEqual(['{"error":{}}', '{"error":{}}']);
  });

  it('does not treat a per-call innerError date as a divergence', () => {
    const at = (date: string) =>
      rawError('https://graph.microsoft.com/v1.0/a', { error: { innerError: { date }, code: 'ErrorItemNotFound' } });
    const { cassette } = scrub([at('2026-09-29T10:00:00'), at('2026-09-29T10:00:05')], meta);
    expect(cassette.interactions).toHaveLength(1);
  });
});

describe('recorder: bounded capture of downloads', () => {
  const MAX = 64; // below the fake's JSON pages: only downloads are bounded, so a page is captured whole
  const site = { kind: 'sharepoint_site' as const, address: 'bank.sharepoint.com:/sites/Big' };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  // A library holding one file with no declared size, so classifyDocument cannot skip it before the download.
  const bigFake = (): { fetch: typeof fetch; served: number[] } => {
    const served: number[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'files.example') {
        served.push(MAX + 10);
        return new Response(new Uint8Array(MAX + 10).fill(65), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      if (url.pathname.endsWith('/sites/bank.sharepoint.com:/sites/Big')) return json({ id: 'S' });
      if (url.pathname.endsWith('/drives')) return json({ value: [{ id: 'D-big' }] });
      if (url.pathname.endsWith('/root/delta')) {
        return json({
          value: [{ id: 'big', name: 'big.txt', file: { mimeType: 'text/plain' }, parentReference: { driveId: 'D-big', path: '/drives/D-big/root:' } }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/D-big/root/delta?token=T',
        });
      }
      if (url.pathname.endsWith('/items/big/content')) return new Response(null, { status: 302, headers: { location: 'https://files.example/big?id=1' } });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { fetch: impl, served };
  };

  it('captures maxBytes + 1 bytes of an oversized body, and the reader still ledgers it too_large, live and on replay', async () => {
    const fake = bigFake();
    const recorder = createRecorder(fake.fetch, { maxBytes: MAX });
    const direct = graphContentSourceOver(SOURCE_KIND.SHAREPOINT_SITE, { http: http(recorder.fetch), maxBytes: MAX, extract });
    const row = { ...sourceRow(site, 0), backfillCompletedAt: null };
    const live = await readBackfillThenDelta(direct, row);
    expect(live.backfill.flatMap((p) => p.skipped ?? []).map((s) => [s.providerItemId, s.reason])).toEqual([['big', 'too_large']]);
    expect(live.backfill.flatMap((p) => p.documents ?? [])).toEqual([]);

    const hop = recorder.raw.find((r) => r.url.startsWith('https://files.example/'))!;
    expect(hop.bytes!.byteLength).toBe(MAX + 1);
    // A JSON page larger than the cap is captured whole.
    const delta = recorder.raw.find((r) => r.url.includes('/root/delta'))!;
    expect(delta.bytes!.byteLength).toBeGreaterThan(MAX);
    expect(() => JSON.parse(new TextDecoder().decode(delta.bytes!))).not.toThrow();

    const { cassette } = scrub(recorder.raw, { sources: [site], recordedAt: FIXED });
    const dir = newDir();
    saveCassette(dir, cassette);
    const loaded = loadCassette(dir);
    expect([...loaded.bodies.values()].map((b) => b.byteLength)).toEqual([MAX + 1]);

    const replayed = await readBackfillThenDelta(
      graphContentSourceOver(SOURCE_KIND.SHAREPOINT_SITE, {
        http: { getToken: async () => 'r', fetchImpl: loaded.fetch, sleep: async () => undefined, maxAttempts: 1 },
        maxBytes: MAX,
        extract,
      }),
      row,
    );
    expect(replayed.backfill.flatMap((p) => p.skipped ?? []).map((s) => [s.providerItemId, s.reason])).toEqual([['big', 'too_large']]);
    expect(masked(replayed)).toEqual(masked(live)); // the oversized page and the delta replay intact
    expect(loaded.fetch.misses).toEqual([]);
  });

  it('bounds a direct /content 200 as well', async () => {
    const recorder = createRecorder((async () => new Response(new Uint8Array(MAX + 10).fill(67), { status: 200 })) as typeof fetch, { maxBytes: MAX });
    await recorder.fetch('https://graph.microsoft.com/v1.0/drives/d/items/i/content');
    expect(recorder.raw[0].bytes!.byteLength).toBe(MAX + 1);
  });

  it('returns a complete body to the reader when it fits', async () => {
    const recorder = createRecorder((async () => new Response(new Uint8Array(MAX).fill(66), { status: 200 })) as typeof fetch, { maxBytes: MAX });
    const res = await recorder.fetch('https://graph.microsoft.com/v1.0/x');
    expect((await res.arrayBuffer()).byteLength).toBe(MAX);
    expect(recorder.raw[0].bytes!.byteLength).toBe(MAX);
  });
});

describe('scrub: orphan hops and divergence', () => {
  const meta = { sources: [], recordedAt: FIXED };
  const G = 'https://graph.microsoft.com/v1.0';
  const enc = (text: string) => new TextEncoder().encode(text);
  const redirect = (url: string, location: string): RawInteraction => ({ method: 'GET', url, status: 302, headers: { location }, bytes: null });
  const hop = (url: string, body: string): RawInteraction => ({
    method: 'GET',
    url,
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
    bytes: enc(body),
  });
  const listing = (body: unknown): RawInteraction => ({
    method: 'GET',
    url: `${G}/sites/s/drives`,
    status: 200,
    headers: { 'content-type': 'application/json' },
    bytes: enc(JSON.stringify(body)),
  });

  it('keeps only the second hop when one key was redirected twice', () => {
    const content = `${G}/drives/d/items/i/content`;
    const { cassette, orphansDropped } = scrub(
      [
        redirect(content, 'https://files.example/a?tempauth=ONE'),
        hop('https://files.example/a?tempauth=ONE', 'same bytes'),
        redirect(content, 'https://files.example/a?tempauth=TWO'),
        hop('https://files.example/a?tempauth=TWO', 'same bytes'),
      ],
      meta,
    );
    expect(orphansDropped).toBe(1);
    expect(cassette.interactions.map((i) => [i.url, i.status])).toEqual([
      [content, 302],
      ['https://replay.invalid/content/1', 200],
    ]);
    expect(cassette.interactions[0].headers.location).toBe('https://replay.invalid/content/1');
    expect(JSON.stringify(cassette.interactions)).not.toMatch(/tempauth|files\.example/);
  });

  it('counts no orphan when every hop is pointed at', () => {
    const { orphansDropped } = scrub([redirect(`${G}/x/content`, 'https://files.example/a'), hop('https://files.example/a', 'b')], meta);
    expect(orphansDropped).toBe(0);
  });

  it('refuses two different final answers for one key, naming a count and no URL', () => {
    const error = (() => {
      try {
        scrub([listing({ value: [{ id: 'a' }] }), listing({ value: [{ id: 'a' }, { id: 'b' }] })], meta);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(ScrubDivergenceError);
    expect(error!.message).toBe('the tenant changed during the recording (1 keys); re-record');
    expect(error!.message).not.toContain('graph.microsoft.com');
  });

  it('does not count property order, retry intermediates or paging tokens as a change', () => {
    const page = (token: string, order: 'ab' | 'ba'): RawInteraction => ({
      method: 'GET',
      url: `${G}/m/delta`,
      status: 200,
      headers: { 'content-type': 'application/json' },
      bytes: enc(order === 'ab' ? `{"a":1,"b":2,"@odata.nextLink":"${G}/m/delta?$skiptoken=${token}"}` : `{"b":2,"a":1,"@odata.nextLink":"${G}/m/delta?$skiptoken=${token}"}`),
    });
    const throttled: RawInteraction = { method: 'GET', url: `${G}/m/delta`, status: 429, headers: { 'retry-after': '0' }, bytes: enc('{}') };
    expect(() => scrub([throttled, page('TOKEN-A', 'ab'), page('TOKEN-B', 'ba')], meta)).not.toThrow();
  });

  it('compares a 3xx by status only, and a final 404 against a later 200', () => {
    expect(() => scrub([redirect(`${G}/c`, 'https://f.example/1'), redirect(`${G}/c`, 'https://f.example/2')], meta)).not.toThrow();
    const gone: RawInteraction = { method: 'GET', url: `${G}/z`, status: 404, headers: { 'content-type': 'application/json' }, bytes: enc('{"error":{"code":"ErrorItemNotFound"}}') };
    expect(() => scrub([gone, { ...gone, status: 200, bytes: enc('{"id":"z"}') }], meta)).toThrow(ScrubDivergenceError);
  });

  it('refuses a repeated download whose second hop carries different bytes', () => {
    const content = `${G}/drives/d/items/i/content`;
    expect(() =>
      scrub(
        [
          redirect(content, 'https://files.example/a?t=1'),
          hop('https://files.example/a?t=1', 'draft 1'),
          redirect(content, 'https://files.example/a?t=2'),
          hop('https://files.example/a?t=2', 'draft 2'),
        ],
        meta,
      ),
    ).toThrow(ScrubDivergenceError);
  });
});

describe('the reader doors of src/lib/mailboxAccess/readers.ts that the cassette scripts use (#262)', () => {
  it('builds no reader without the transport to read through, so it never falls back to the network', () => {
    expect(() => graphContentSourceOver(SOURCE_KIND.MAILBOX, { http: { getToken: async () => 'token' } })).toThrow(/http\.fetchImpl/);
    expect(() => graphContentSourceOver(SOURCE_KIND.MAILBOX, { http: http(createFakeTenant().fetch) })).not.toThrow();
  });

  it('serves the synthetic bank.example corpus and nothing else', () => {
    const corpus = loadFixtureCorpus();
    expect(corpus.length).toBeGreaterThan(0);
    expect(corpus.every((file) => file.mailbox.endsWith('@bank.example'))).toBe(true);
  });
});

describe('recorder: observe() is the capture, and the completeness rules live in it (#318)', () => {
  const G = 'https://graph.microsoft.com/v1.0';
  const GUID = '0f9d1c2e-1111-4222-8333-444455556666';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const refusalOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      expect(error).toBeInstanceOf(RecorderRefusal);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('observe(request, response) records exactly what fetch records: the same scrubbed cassette', async () => {
    const capture = async (viaObserve: boolean) => {
      const fake = createFakeTenant();
      const recorder = createRecorder(fake.fetch);
      const fetchImpl = viaObserve
        ? ((async (input: string | URL | Request, init?: RequestInit) =>
            recorder.observe({ method: init?.method ?? 'GET', url: String(input) }, await fake.fetch(input, init))) as typeof fetch)
        : recorder.fetch;
      for (const [index, source] of fakeTenantSources().entries()) {
        await readBackfillThenDelta(graphContentSourceOver(source.kind, { http: http(fetchImpl), extract }), sourceRow(source, index));
      }
      return { raw: recorder.raw, ...scrub(recorder.raw, { sources: fakeTenantSources(), recordedAt: FIXED }) };
    };
    const viaFetch = await capture(false);
    const viaObserve = await capture(true);
    expect(viaFetch.raw.length).toBeGreaterThan(0);
    expect(viaObserve.raw).toEqual(viaFetch.raw);
    expect(viaObserve.cassette).toEqual(viaFetch.cassette);
  });

  it('returns the reader a response with the recorded status, headers and bytes', async () => {
    const recorder = createRecorder((async () => json({ value: [{ id: 'a' }] })) as typeof fetch);
    const res = await recorder.observe({ method: 'GET', url: `${G}/users/a%40b.example/mailFolders` }, json({ value: [{ id: 'a' }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ value: [{ id: 'a' }] });
    expect(recorder.raw).toHaveLength(1);
  });

  it('aborts on a 2xx collection or delta page whose value is not an array, recording nothing', async () => {
    const urls = [
      `${G}/users/a%40b.example/mailFolders?$select=id,childFolderCount&$top=100`,
      `${G}/users/a%40b.example/mailFolders/F1/childFolders?$select=id&$top=100`,
      `${G}/users/a%40b.example/mailFolders/F1/messages/delta?$select=id`,
      `${G}/users/a%40b.example/mailFolders/F1/messages/delta?$skiptoken=r1`,
      `${G}/sites/s/drives?$select=id,name`,
      `${G}/drives/D1/root/delta?$select=id`,
      `${G}/drives/D1/root/delta?token=r1`,
      `${G}/drives/D1/root/delta(token='r1')`,
      `${G}/users/a%40b.example/mailFolders/F1/messages/microsoft.graph.delta?$skiptoken=r1`,
      `${G}/drives/D1/root/microsoft.graph.delta(token='r1')`,
    ];
    for (const url of urls) {
      for (const body of [{}, { value: null }, { value: { id: 'a' } }, 'not json at all']) {
        const recorder = createRecorder((async () => (typeof body === 'string' ? new Response(body, { status: 200 }) : json(body))) as typeof fetch);
        expect(await refusalOf(() => recorder.fetch(url)), url).toBe('a collection page had no value array; nothing is written');
        expect(recorder.raw).toEqual([]);
      }
    }
  });

  it('accepts a well-formed or empty collection page, and a single resource, a refusal status or a download that has no value', async () => {
    const ok = (body: unknown, status = 200) => createRecorder((async () => json(body, status)) as typeof fetch);
    for (const url of [`${G}/users/a%40b.example/mailFolders?$top=100`, `${G}/drives/D1/root/delta?token=r1`]) {
      const recorder = ok({ value: [] });
      await recorder.fetch(url);
      expect(recorder.raw).toHaveLength(1);
    }
    const single = ok({ id: 'F1' });
    await single.fetch(`${G}/users/a%40b.example/mailFolders/deleteditems?$select=id`);
    await single.fetch(`${G}/sites/bank.sharepoint.com:/sites/Deals?$select=id`);
    expect(single.raw).toHaveLength(2);

    const missing = ok({ error: { code: 'ErrorItemNotFound' } }, 404);
    await missing.fetch(`${G}/users/a%40b.example/mailFolders`);
    expect(missing.raw.map((r) => r.status)).toEqual([404]);

    const download = createRecorder((async () => new Response('bytes, not json', { status: 200 })) as typeof fetch);
    await download.fetch('https://files.example/delta');
    await download.fetch(`${G}/drives/D1/items/i/content`);
    expect(download.raw).toHaveLength(2);
  });

  it('aborts a recording whose mailbox folder list has no value, so an empty list is not read as a finished cycle', async () => {
    const fake = createFakeTenant();
    const stripped = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/mailFolders')) return json({ '@odata.context': 'x' });
      return fake.fetch(input, init);
    }) as typeof fetch;
    const mailbox = fakeTenantSources().find((s) => s.kind === 'mailbox')!;
    expect(await refusalOf(() => recordSources({ http: http(stripped), sources: [mailbox], recordedAt: FIXED }))).toMatch(/no value array/);
  });

  it('aborts on any URL that addresses a user by object id, through fetch or observe, recording nothing', async () => {
    for (const url of [
      `${G}/users/${GUID}/mailFolders/inbox?$select=id`,
      `${G}/users/${GUID.toUpperCase()}/mailFolders`,
      `${G}/users/${encodeURIComponent(GUID)}/mailFolders/inbox`,
      `${G}/users/${GUID}`,
      `${G}/users('${GUID}')/mailFolders/inbox`,
      `${G}/users('${GUID.toUpperCase()}')`,
    ]) {
      const recorder = createRecorder((async () => json({ id: 'F1' })) as typeof fetch);
      expect(await refusalOf(() => recorder.fetch(url)), url).toBe('a read addressed a user by object id; nothing is written');
      expect(await refusalOf(() => recorder.observe({ method: 'GET', url }, json({ id: 'F1' })))).toMatch(/object id/);
      expect(recorder.raw).toEqual([]);
    }
    // A mailbox addressed by address, or a path that merely contains a guid elsewhere, is not an object-id read.
    const recorder = createRecorder((async () => json({ id: 'F1' })) as typeof fetch);
    await recorder.fetch(`${G}/users/a%40b.example/mailFolders/inbox?$select=id`);
    await recorder.fetch(`${G}/sites/s,${GUID},${GUID}?$select=id`);
    expect(recorder.raw).toHaveLength(2);
  });

  it('refuses an object-id read before sending it, and an abort is sticky so a graphFetch retry never reaches Graph', async () => {
    let sent = 0;
    const recorder = createRecorder((async () => {
      sent += 1;
      return json({});
    }) as typeof fetch);
    expect(await refusalOf(() => recorder.fetch(`${G}/users/${GUID}/mailFolders/inbox?$select=id`))).toMatch(/object id/);
    expect(sent).toBe(0);
    // graphFetch retries a transport that throws: the retry, and any later request, fails with the first refusal.
    expect(await refusalOf(() => recorder.fetch(`${G}/users/a%40b.example/mailFolders`))).toMatch(/object id/);
    expect(await refusalOf(() => recorder.observe({ method: 'GET', url: `${G}/users/a%40b.example/mailFolders` }, json({ value: [] })))).toMatch(/object id/);
    expect(sent).toBe(0);
    expect(recorder.raw).toEqual([]);

    const malformed = createRecorder((async () => {
      sent += 1;
      return json({});
    }) as typeof fetch);
    const folders = `${G}/users/a%40b.example/mailFolders?$top=100`;
    expect(await refusalOf(() => malformed.fetch(folders))).toMatch(/no value array/);
    expect(await refusalOf(() => malformed.fetch(folders))).toMatch(/no value array/);
    expect(sent).toBe(1);
  });

  it('still records GET only, before sending a request and when observing one', async () => {
    let sent = 0;
    const recorder = createRecorder((async () => {
      sent += 1;
      return json({ value: [] });
    }) as typeof fetch);
    await expect(recorder.fetch(`${G}/x`, { method: 'POST' })).rejects.toThrow(/GET only/);
    expect(sent).toBe(0);
    await expect(recorder.observe({ method: 'post', url: `${G}/x` }, json({}))).rejects.toThrow(/GET only/);
  });
});

describe('readBackfillThenDelta: a recording is a complete cycle', () => {
  const row = { ...sourceRow({ kind: SOURCE_KIND.MAILBOX, address: 'a@bank.example' }, 0), backfillCompletedAt: null };
  const page = (cycle: unknown, extra: Record<string, unknown> = {}): SourceItemPage => ({
    items: [],
    nextCheckpoint: JSON.stringify({ v: 1, kind: 'graph-mail', ...(cycle === undefined ? {} : { cycle }), folders: [], ...extra }),
  });
  const reader = (backfill: SourceItemPage[], delta: SourceItemPage[]): ContentSource => ({
    kind: SOURCE_KIND.MAILBOX,
    async *backfill() {
      yield* backfill;
    },
    async *delta() {
      yield* delta;
    },
  });
  const refusal = async (read: Promise<unknown>) => {
    try {
      await read;
    } catch (error) {
      expect(error).toBeInstanceOf(RecorderRefusal);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('returns both passes when each ends complete', async () => {
    const read = await readBackfillThenDelta(reader([page('running'), page('complete')], [page('running'), page('complete')]), row);
    expect(read.backfill).toHaveLength(2);
    expect(read.delta).toHaveLength(2);
  });

  it('refuses a backfill whose last checkpoint is still running, naming the pass and no value', async () => {
    const text = await refusal(readBackfillThenDelta(reader([page('complete'), page('running')], [page('complete')]), row));
    expect(text).toBe('the backfill did not complete every folder or library; nothing is written');
  });

  it('refuses a delta whose last checkpoint is still running', async () => {
    const text = await refusal(readBackfillThenDelta(reader([page('complete')], [page('complete'), page('running')]), row));
    expect(text).toBe('the delta did not complete every folder or library; nothing is written');
  });

  it('refuses a checkpoint that cannot show completion: no cycle, an unknown cycle, not JSON, or none at all', async () => {
    for (const backfill of [[page(undefined)], [page('finished')], [{ items: [], nextCheckpoint: 'not json' }], [{ items: [], nextCheckpoint: null }], []]) {
      expect(await refusal(readBackfillThenDelta(reader(backfill, [page('complete')]), row))).toMatch(/backfill did not complete/);
    }
  });

  it('accepts a delta that yielded no page: no folder was read, so no cycle is partial', async () => {
    const read = await readBackfillThenDelta(reader([page('complete')], []), row);
    expect(read.delta).toEqual([]);
  });
});
