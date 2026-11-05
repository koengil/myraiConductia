// @vitest-environment node
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import type { GraphHttpOptions } from '@/lib/graph/http';
import type { SourceItemPage, SourceRow } from '@/lib/graph/reader';
import { createGraphDriveContentSource, parseDriveCheckpoint } from '@/lib/graph/reader/drive';
import { classifyDocument, extractText } from '@/lib/graph/reader/extractText';
import { readerCapability } from './readerCapability';
import { runSyncJobs, SYNC_MAX_PAGES, type SourceDbState } from './syncJobs';

/*
 * The SharePoint reader over a stubbed Graph, and the sandboxed extractor
 * over real bytes. The extractor runs as a real child process under Node's
 * permission model; the reader tests stub it.
 */

// ── Tiny document builders ───────────────────────────────────────────────────

function pdf(text: string): Buffer {
  const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function zip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  return zip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', `<w:document><w:body>${body}</w:body></w:document>`],
  ]);
}

// ── The sandboxed extractor ──────────────────────────────────────────────────

describe('classifyDocument', () => {
  it('decides from the name and type before anything is read', () => {
    expect(classifyDocument('Falcon CIM.pdf', 'application/pdf', 1000)).toEqual({ kind: 'extract', format: 'pdf' });
    expect(classifyDocument('Falcon EL.docx', null, 1000)).toEqual({ kind: 'extract', format: 'docx' });
    expect(classifyDocument('notes.txt', 'text/plain', 10)).toEqual({ kind: 'extract', format: 'text' });
    expect(classifyDocument('org chart.png', 'image/png', 10)).toEqual({ kind: 'skip', reason: 'image_only' });
    expect(classifyDocument('scan.TIFF', null, 10)).toEqual({ kind: 'skip', reason: 'image_only' });
    expect(classifyDocument('model.xlsx', null, 10)).toEqual({ kind: 'skip', reason: 'unsupported_type' });
    expect(classifyDocument('huge.pdf', 'application/pdf', 26 * 1024 * 1024)).toEqual({ kind: 'skip', reason: 'too_large' });
  });
});

describe('extractText (a sandboxed child process)', () => {
  it('reads a PDF text layer', async () => {
    expect(await extractText(pdf('Project Falcon management presentation'), 'pdf')).toEqual({
      ok: true,
      text: 'Project Falcon management presentation',
    });
  }, 30_000);

  it('reads a DOCX, entities decoded and paragraphs kept', async () => {
    expect(await extractText(docx(['Project Cobra &amp; engagement letter', 'Fee: 1.5%']), 'docx')).toEqual({
      ok: true,
      text: 'Project Cobra & engagement letter\nFee: 1.5%',
    });
  }, 30_000);

  it('reports a PDF with no text layer as image_only (no OCR in scope)', async () => {
    expect(await extractText(pdf(''), 'pdf')).toEqual({ ok: false, reason: 'image_only' });
  }, 30_000);

  it('reports garbage as extraction_failed, never the parser error', async () => {
    expect(await extractText(Buffer.from('not a zip at all'), 'docx')).toEqual({ ok: false, reason: 'extraction_failed' });
  }, 30_000);

  it('kills a parser that runs past the timeout', async () => {
    expect(await extractText(pdf('Project Falcon'), 'pdf', { timeoutMs: 1 })).toEqual({
      ok: false,
      reason: 'extraction_timeout',
    });
  }, 30_000);

  it('runs the child with no environment, the permission model and a heap cap', async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('stop here');
    });
    await extractText(Buffer.from('x'), 'text', { spawnImpl: spawnImpl as never }).catch(() => undefined);
    const [command, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], { env: object }];
    expect(command).toBe(process.execPath);
    expect(args).toContain('--permission');
    expect(args).toContain('--max-old-space-size=256');
    expect(args.filter((a) => a.startsWith('--allow-fs-read=')).length).toBe(2);
    expect(args.some((a) => a.startsWith('--allow-fs-write') || a.startsWith('--allow-child-process'))).toBe(false);
    expect(options.env).toEqual({});
  });
});

// ── The drive reader ─────────────────────────────────────────────────────────

const G = 'https://graph.microsoft.com/v1.0';
const SITE = 'bank.sharepoint.com,site-guid,web-guid';
const DRIVE_SELECT =
  '$select=id,name,size,file,folder,deleted,parentReference,lastModifiedDateTime,createdBy,lastModifiedBy,cTag,eTag';

function file(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    size: 2048,
    file: { mimeType: name.endsWith('.png') ? 'image/png' : 'application/octet-stream' },
    parentReference: { driveId: 'D1', path: '/drives/D1/root:/Deals/Falcon' },
    lastModifiedDateTime: '2026-03-01T10:00:00Z',
    createdBy: { user: { email: 'Morgan.Vale@bank.example', displayName: 'Morgan Vale' } },
    lastModifiedBy: { user: { email: 'storm.duncan@bank.example', displayName: 'Storm Duncan' } },
    cTag: `c-${id}`,
    ...extra,
  };
}

function fakeGraph() {
  const routes = new Map<string, { status?: number; body?: unknown; headers?: Record<string, string> }>([
    [`${G}/sites/${encodeURIComponent(SITE)}?$select=id`, { body: { id: SITE } }],
    [`${G}/sites/${encodeURIComponent(SITE)}/drives?$select=id,name`, { body: { value: [{ id: 'D1', name: 'Documents' }] } }],
    [
      `${G}/drives/D1/root/delta?${DRIVE_SELECT}`,
      {
        body: {
          value: [
            { id: 'root', name: 'root', folder: {} },
            file('f-cim', 'Falcon CIM.docx'),
            file('f-org', 'org chart.png'),
            file('f-gone', 'old.docx', { deleted: { state: 'deleted' } }),
          ],
          '@odata.nextLink': `${G}/drives/D1/delta?$skiptoken=2`,
        },
      },
    ],
    [
      `${G}/drives/D1/delta?$skiptoken=2`,
      { body: { value: [file('f-model', 'model.xlsx'), file('f-scan', 'scan.pdf')], '@odata.deltaLink': `${G}/drives/D1/delta?$deltatoken=d1` } },
    ],
    [`${G}/drives/D1/items/f-cim/content`, { status: 302, headers: { Location: 'https://bank.sharepoint.com/dl/f-cim' } }],
    [`${G}/drives/D1/items/f-scan/content`, { status: 302, headers: { Location: 'https://bank.sharepoint.com/dl/f-scan' } }],
    ['https://bank.sharepoint.com/dl/f-cim', { body: 'docx-bytes' }],
    ['https://bank.sharepoint.com/dl/f-scan', { body: 'pdf-bytes' }],
  ]);
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const route = routes.get(url);
    if (!route) return new Response('{}', { status: 404 });
    const body = route.body === undefined ? null : typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  }) as typeof fetch;
  const http: GraphHttpOptions = { getToken: async () => 'token', fetchImpl, sleep: async () => undefined };
  return { http, requested };
}

const SOURCE: SourceRow = {
  id: 'src-site',
  tenantId: 't-1',
  kind: 'sharepoint_site',
  provider: 'microsoft',
  address: SITE,
  ownerUserId: null,
  deltaCheckpoint: null,
};

async function collect(pages: AsyncIterable<SourceItemPage>) {
  const out: SourceItemPage[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

describe('graph drive reader', () => {
  it('reads documents into text, skips images and unsupported files, and checkpoints each page', async () => {
    const graph = fakeGraph();
    const extract = vi.fn(async (bytes: Uint8Array, format: string) =>
      Buffer.from(bytes).toString() === 'docx-bytes' && format === 'docx'
        ? { ok: true as const, text: 'Project Falcon confidential information memorandum' }
        : { ok: false as const, reason: 'image_only' as const },
    );
    const reader = createGraphDriveContentSource(readerCapability, { http: graph.http, extract });
    const pages = await collect(reader.backfill(SOURCE, null));

    expect(pages).toHaveLength(3);
    expect(pages[1].documents).toEqual([
      {
        driveItemKey: 'D1:f-cim',
        providerItemId: 'f-cim',
        name: 'Falcon CIM.docx',
        drivePath: '/Deals/Falcon/Falcon CIM.docx',
        lastModifiedDateTime: '2026-03-01T10:00:00Z',
        authors: [
          { address: 'morgan.vale@bank.example', name: 'Morgan Vale' },
          { address: 'storm.duncan@bank.example', name: 'Storm Duncan' },
        ],
        text: 'Project Falcon confidential information memorandum',
        cTag: 'c-f-cim',
      },
    ]);
    expect(pages[1].skipped?.map((s) => [s.providerItemId, s.reason])).toEqual([['f-org', 'image_only']]);
    // The unsupported file is never downloaded; the scan is, and has no text layer.
    expect(pages[2].skipped?.map((s) => [s.providerItemId, s.reason])).toEqual([
      ['f-model', 'unsupported_type'],
      ['f-scan', 'image_only'],
    ]);
    expect(graph.requested.some((u) => u.includes('f-model/content') || u.includes('f-org/content'))).toBe(false);
    expect(extract).toHaveBeenCalledTimes(2);

    const done = parseDriveCheckpoint(pages[2].nextCheckpoint!);
    expect(done).toEqual({ v: 1, kind: 'graph-drive', siteId: SITE, cycle: 'complete', drives: [{ id: 'D1', link: `${G}/drives/D1/delta?$deltatoken=d1`, done: true }] });
  });

  it('resumes from the stored checkpoint without re-reading the first page', async () => {
    const extract = vi.fn(async () => ({ ok: false as const, reason: 'image_only' as const }));
    const first = await collect(createGraphDriveContentSource(readerCapability, { http: fakeGraph().http, extract }).backfill(SOURCE, null));
    const afterFirstPage = first[1].nextCheckpoint!;

    const graph = fakeGraph();
    const resumed = await collect(createGraphDriveContentSource(readerCapability, { http: graph.http, extract }).backfill(SOURCE, afterFirstPage));
    expect(resumed).toHaveLength(1);
    expect(graph.requested[0]).toBe(`${G}/drives/D1/delta?$skiptoken=2`);
    expect(graph.requested.some((u) => u.includes('root/delta') || u.includes('/sites/'))).toBe(false);
  });
});

describe('graph drive reader across the worker page limit', () => {
  // More libraries than one job reads: the delta used to reset every library
  // to unread on every job, so the last one was never reached.
  const DRIVES = Array.from({ length: SYNC_MAX_PAGES + 1 }, (_, i) => `D-${i}`);

  function manyDrives() {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === `${G}/sites/${encodeURIComponent(SITE)}?$select=id`) return Response.json({ id: SITE });
      if (url === `${G}/sites/${encodeURIComponent(SITE)}/drives?$select=id,name`) {
        return Response.json({ value: DRIVES.map((id) => ({ id, name: id })) });
      }
      const start = /\/drives\/(D-\d+)\/root\/delta\?/.exec(url);
      if (start) return Response.json({ value: [], '@odata.deltaLink': `${G}/drives/${start[1]}/delta?$deltatoken=d1` });
      const delta = /\/drives\/(D-\d+)\/delta\?\$deltatoken=(d\d)$/.exec(url);
      if (delta) {
        const [, drive, token] = delta;
        // One new image per library after the backfill (ledgered, never downloaded), then nothing.
        const value = token === 'd1' ? [file(`${drive}-photo`, 'photo.png')] : [];
        return Response.json({ value, '@odata.deltaLink': `${G}/drives/${drive}/delta?$deltatoken=d2` });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return { http: { getToken: async () => 'token', fetchImpl, sleep: async () => undefined } as GraphHttpOptions, requested };
  }

  it('finishes a delta cycle over more libraries than one job reads, then starts the next from the new links', async () => {
    const graph = manyDrives();
    const reader = createGraphDriveContentSource(readerCapability, { http: graph.http, extract: vi.fn() });
    const row: SourceDbState = { delta_checkpoint: null, backfill_completed_at: null };

    const backfill = await runSyncJobs(reader, SOURCE, row);
    expect(backfill.map((j) => [j.mode, j.status])).toEqual([
      ['backfill', 'page_limit'],
      ['backfill', 'complete'],
    ]);

    graph.requested.length = 0;
    const cycle = await runSyncJobs(reader, SOURCE, row);
    expect(cycle.map((j) => [j.mode, j.status])).toEqual([
      ['delta', 'page_limit'],
      ['delta', 'complete'],
    ]);
    expect(cycle.reduce((sum, j) => sum + j.itemsRead, 0)).toBe(DRIVES.length);
    const reads = graph.requested.filter((u) => u.includes('$deltatoken='));
    expect(reads.filter((u) => u.endsWith('d1'))).toHaveLength(DRIVES.length);
    expect(reads.filter((u) => u.endsWith('d2'))).toHaveLength(0);
    const done = parseDriveCheckpoint(row.delta_checkpoint!);
    expect(done.cycle).toBe('complete');
    expect(done.drives.every((d) => d.done && d.link?.endsWith('d2'))).toBe(true);

    graph.requested.length = 0;
    const next = await runSyncJobs(reader, SOURCE, row);
    expect(next.map((j) => j.status)).toEqual(['page_limit', 'complete']);
    expect(graph.requested.filter((u) => u.endsWith('$deltatoken=d2'))).toHaveLength(DRIVES.length);
  });
});

describe('graph drive reader: the pass record count (#370)', () => {
  const extract = vi.fn(async () => ({ ok: false as const, reason: 'image_only' as const }));

  it('counts one fetch per download that returned bytes, and none for a skip decided before the download', async () => {
    const reader = createGraphDriveContentSource(readerCapability, { http: fakeGraph().http, extract });
    const pages = await collect(reader.backfill(SOURCE, null));
    // Page 1: the CIM is downloaded, the image is not. Page 2: the spreadsheet is not, the scan is.
    expect(pages.map((p) => p.fetched ?? 0)).toEqual([0, 1, 1]);
  });

  it('counts none for a download that stopped in flight over the cap (too_large)', async () => {
    const reader = createGraphDriveContentSource(readerCapability, { http: fakeGraph().http, extract, maxBytes: 5 });
    const pages = await collect(reader.backfill(SOURCE, null));
    expect(pages.flatMap((p) => p.skipped ?? []).filter((s) => s.reason === 'too_large').map((s) => s.providerItemId)).toEqual([
      'f-cim',
      'f-scan',
    ]);
    expect(pages.map((p) => p.fetched ?? 0)).toEqual([0, 0, 0]);
  });
});
