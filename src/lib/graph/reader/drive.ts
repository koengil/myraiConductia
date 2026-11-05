// The live Graph SharePoint reader (phase 4): a ContentSource over the delta
// query of each document library of one site.
//
//   GET /sites/{site}                         the site id, once
//   GET /sites/{siteId}/drives                its document libraries
//   GET /drives/{driveId}/root/delta          each library's changes
//   GET /drives/{driveId}/items/{id}/content  a file's bytes (302 to a
//                                             pre-authenticated URL)
//
// App-only with Sites.Selected, granted per site (ADR-005); a site that was
// not granted answers 403. content_sources.address is the site: a Graph site
// id (`contoso.sharepoint.com,<guid>,<guid>`) or `contoso.sharepoint.com:/sites/Deals`.
//
// A file's text comes from the sandboxed extractor (extractText.ts); its bytes
// are never stored. Images and PDFs without a text layer are out of scope and
// ledgered as image_only; other types as unsupported_type; oversized files as
// too_large without being downloaded; extractor failures as extraction_failed
// or extraction_timeout.
//
// The checkpoint mirrors the mail reader's, one resume link per library, and
// a delta cycle the worker stopped on its page limit is continued the same way:
//   { "v": 1, "kind": "graph-drive", "siteId": "...", "cycle": "running",
//     "drives": [{ "id": "...", "link": "https://graph.microsoft.com/...", "done": false }] }

import { createHash } from 'node:crypto';

import {
  graphDownload,
  graphJson,
  graphPages,
  GraphDownloadTooLargeError,
  type GraphHttpOptions,
} from '@/lib/graph/http';
import { SKIP_REASON, SOURCE_KIND } from '@/lib/constants/discovery';
import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import {
  classifyDocument,
  EXTRACT_DEFAULTS,
  extractText as defaultExtract,
  type DocumentFormat,
  type DocumentSkipReason,
  type ExtractResult,
} from './extractText';
import {
  cycleOf,
  isDeltaCycle,
  type ContentSource,
  type DeltaCycle,
  type GraphDocument,
  type SkippedItem,
  type SourceItemPage,
  type SourceRow,
} from './types';

export const DRIVE_PAGE_SIZE = 20;

const DRIVE_ITEM_SELECT = [
  'id',
  'name',
  'size',
  'file',
  'folder',
  'deleted',
  'parentReference',
  'lastModifiedDateTime',
  'createdBy',
  'lastModifiedBy',
  'cTag',
  'eTag',
].join(',');

export type DriveState = { id: string; link: string | null; done: boolean };
export type DriveCheckpoint = { v: 1; kind: 'graph-drive'; siteId: string; cycle?: DeltaCycle; drives: DriveState[] };

export function parseDriveCheckpoint(raw: string): DriveCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('graph drive reader: the checkpoint is not JSON');
  }
  const value = parsed as Partial<DriveCheckpoint>;
  if (
    value?.v !== 1 ||
    value.kind !== 'graph-drive' ||
    typeof value.siteId !== 'string' ||
    !Array.isArray(value.drives) ||
    (value.cycle !== undefined && !isDeltaCycle(value.cycle))
  ) {
    throw new Error('graph drive reader: the checkpoint is not a graph-drive checkpoint');
  }
  return value as DriveCheckpoint;
}

type Identity = { user?: { email?: string | null; displayName?: string | null } | null } | null;

export type DeltaDriveItem = {
  id: string;
  name?: string;
  size?: number;
  file?: { mimeType?: string | null } | null;
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { driveId?: string; path?: string | null } | null;
  lastModifiedDateTime?: string | null;
  createdBy?: Identity;
  lastModifiedBy?: Identity;
  cTag?: string | null;
  eTag?: string | null;
};

function sitePath(address: string): string {
  // `host:/sites/x` keeps its colon syntax; a site id is one path segment.
  return address.includes(':/') ? `/sites/${address}` : `/sites/${encodeURIComponent(address)}`;
}

function drivePathOf(item: DeltaDriveItem): string {
  const parent = item.parentReference?.path ?? '';
  const folder = parent.replace(/^\/drives?\/[^/]*\/?root:?/, '').replace(/^\/drive\/root:?/, '');
  const name = item.name ?? item.id;
  return folder ? `${folder.replace(/\/$/, '')}/${name}` : name;
}

function authorsOf(item: DeltaDriveItem): GraphDocument['authors'] {
  const seen = new Set<string>();
  const out: GraphDocument['authors'] = [];
  for (const identity of [item.createdBy, item.lastModifiedBy]) {
    const address = identity?.user?.email?.trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, name: identity?.user?.displayName?.trim() || null });
  }
  return out;
}

export type ExtractFn = (bytes: Uint8Array, format: DocumentFormat) => Promise<ExtractResult>;

/** Demands the reader capability, like the mail reader (#262): a live site reader is only built behind the guard. */
export function createGraphDriveContentSource(
  capability: ReaderCapability,
  options: {
    http: GraphHttpOptions;
    extract?: ExtractFn;
    maxBytes?: number;
  },
): ContentSource {
  requireReaderCapability(capability);
  const http: GraphHttpOptions = {
    ...options.http,
    headers: { Prefer: `odata.maxpagesize=${DRIVE_PAGE_SIZE}`, ...(options.http.headers ?? {}) },
  };
  const extract = options.extract ?? ((bytes, format) => defaultExtract(bytes, format));
  const maxBytes = options.maxBytes ?? EXTRACT_DEFAULTS.maxBytes;

  async function listDrives(siteId: string): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of graphPages<{ id: string }>(`/sites/${encodeURIComponent(siteId)}/drives?$select=id,name`, http)) {
      for (const drive of page.value) ids.push(drive.id);
    }
    return ids;
  }

  async function readItem(
    driveId: string,
    item: DeltaDriveItem,
    tally: { fetched: number },
  ): Promise<GraphDocument | SkippedItem | null> {
    if (item.deleted !== undefined || item.folder !== undefined || !item.file) return null;
    const driveItemKey = `${driveId}:${item.id}`;
    const itemHash = createHash('sha256')
      .update(`${driveItemKey}\n${item.cTag ?? item.eTag ?? ''}\n${item.size ?? ''}`)
      .digest('hex');
    const name = item.name ?? item.id;
    const skip = (reason: DocumentSkipReason): SkippedItem => ({ providerItemId: item.id, itemHash, reason });

    const klass = classifyDocument(name, item.file.mimeType, item.size);
    if (klass.kind === 'skip') return skip(klass.reason);

    let bytes: Uint8Array;
    try {
      bytes = await graphDownload(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/content`, {
        ...http,
        maxBytes,
      });
    } catch (error) {
      // Stopped in flight: not counted as fetched.
      if (error instanceof GraphDownloadTooLargeError) return skip(SKIP_REASON.TOO_LARGE);
      throw error;
    }
    // The bytes came back: fetched, whatever the extractor then makes of them (#370 R1-M2, R2-M1).
    tally.fetched += 1;
    const result = await extract(bytes, klass.format);
    if (!result.ok) return skip(result.reason);
    return {
      driveItemKey,
      providerItemId: item.id,
      name,
      drivePath: drivePathOf(item),
      lastModifiedDateTime: item.lastModifiedDateTime ?? null,
      authors: authorsOf(item),
      text: result.text,
      cTag: item.cTag ?? null,
    };
  }

  async function* readDrives(state: DriveCheckpoint): AsyncIterable<SourceItemPage> {
    for (const drive of state.drives) {
      if (drive.done) continue;
      const start = drive.link ?? `/drives/${encodeURIComponent(drive.id)}/root/delta?$select=${DRIVE_ITEM_SELECT}`;
      for await (const page of graphPages<DeltaDriveItem>(start, http)) {
        const documents: GraphDocument[] = [];
        const skipped: SkippedItem[] = [];
        const tally = { fetched: 0 };
        for (const item of page.value) {
          const read = await readItem(drive.id, item, tally);
          if (!read) continue;
          if ('reason' in read) skipped.push(read);
          else documents.push(read);
        }
        drive.link = page.nextLink ?? page.deltaLink ?? drive.link;
        if (page.deltaLink) drive.done = true;
        state.cycle = cycleOf(state.drives);
        yield { items: [], documents, skipped, fetched: tally.fetched, nextCheckpoint: JSON.stringify(state) };
      }
    }
  }

  return {
    kind: SOURCE_KIND.SHAREPOINT_SITE,

    async *backfill(source: SourceRow, checkpoint) {
      let state: DriveCheckpoint;
      if (checkpoint) {
        state = parseDriveCheckpoint(checkpoint);
      } else {
        const site = await graphJson<{ id: string }>(`${sitePath(source.address)}?$select=id`, http);
        const drives = await listDrives(site.id);
        const states = drives.map((id) => ({ id, link: null, done: false }));
        state = { v: 1, kind: 'graph-drive', siteId: site.id, cycle: cycleOf(states), drives: states };
        yield { items: [], documents: [], skipped: [], nextCheckpoint: JSON.stringify(state) };
      }
      yield* readDrives(state);
    },

    async *delta(_source: SourceRow, token) {
      const state = parseDriveCheckpoint(token);
      const current = await listDrives(state.siteId);
      const known = new Map(state.drives.map((drive) => [drive.id, drive]));
      state.drives = current.map((id) => known.get(id) ?? { id, link: null, done: false });
      // As the mail reader: continue a running cycle, restart a completed one.
      if (state.cycle !== 'running' || state.drives.every((drive) => drive.done)) {
        state.drives = state.drives.map((drive) => ({ ...drive, done: false }));
      }
      state.cycle = cycleOf(state.drives);
      yield* readDrives(state);
    },
  };
}
