// The live Graph mailbox reader (phase 4): a ContentSource over the messages
// delta query of each mail folder of one mailbox.
//
//   GET /users/{mailbox}/mailFolders/{folder}/messages/delta
//
// App-only, Mail.Read scoped by RBAC for Applications to the in-scope
// mailboxes (ADR-005); a mailbox outside the scope answers 403. Immutable ids
// are requested, so moving a message between folders keeps its provider id.
//
// The checkpoint is one JSON document per mailbox, persisted by the worker
// after every page, holding each folder's resume link: the @odata.nextLink
// while a folder is being read, then its @odata.deltaLink once it is done.
// `cycle` says whether every folder has been read to its deltaLink.
//
//   { "v": 1, "kind": "graph-mail", "cycle": "running",
//     "folders": [{ "id": "...", "link": "https://graph.microsoft.com/...", "done": true }, ...] }
//
// A backfill resumed from a checkpoint skips finished folders and continues
// the current one from its nextLink, so nothing is read twice. A delta pass
// re-lists the folders (a new folder starts from scratch) and reads each from
// its deltaLink: only what changed. A delta pass the worker stopped on its
// page limit leaves the cycle running, and the next job continues it; only a
// completed cycle marks every folder unread again. Deleted messages
// (@removed) are ignored: what was stored stays, and a correction removes it
// (phase 7/8).

import { graphJson, graphPages, GraphHttpError, type GraphHttpOptions } from '@/lib/graph/http';
import { SOURCE_KIND } from '@/lib/constants/discovery';
import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import type { ReadKey } from '@/lib/mailboxAccess/mirror';
import { cycleOf, isDeltaCycle, type ContentSource, type DeltaCycle, type GraphMessage, type SourceItemPage, type SourceRow } from './types';

export const MAIL_PAGE_SIZE = 50;

/** Folders that hold no deal correspondence, or not yet. */
export const EXCLUDED_WELL_KNOWN_FOLDERS = ['deleteditems', 'junkemail', 'drafts', 'outbox', 'recoverableitemsdeletions'];

const MESSAGE_SELECT = [
  'id',
  'internetMessageId',
  'conversationId',
  'subject',
  'sentDateTime',
  'receivedDateTime',
  'from',
  'toRecipients',
  'ccRecipients',
  'body',
  'hasAttachments',
].join(',');

export type MailFolderState = { id: string; link: string | null; done: boolean };
export type MailCheckpoint = { v: 1; kind: 'graph-mail'; cycle?: DeltaCycle; folders: MailFolderState[] };

export function parseMailCheckpoint(raw: string): MailCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('graph mail reader: the checkpoint is not JSON');
  }
  const value = parsed as Partial<MailCheckpoint>;
  if (
    value?.v !== 1 ||
    value.kind !== 'graph-mail' ||
    !Array.isArray(value.folders) ||
    (value.cycle !== undefined && !isDeltaCycle(value.cycle))
  ) {
    throw new Error('graph mail reader: the checkpoint is not a graph-mail checkpoint');
  }
  for (const folder of value.folders) {
    if (typeof folder?.id !== 'string' || typeof folder.done !== 'boolean') {
      throw new Error('graph mail reader: the checkpoint has a malformed folder');
    }
  }
  return value as MailCheckpoint;
}

function mailboxPath(source: SourceRow): string {
  return `/users/${encodeURIComponent(source.address)}`;
}

// TODO(#353 F1): content_sources.backfill_since is not honoured here yet; a Microsoft mailbox's first read takes every folder whole.
function initialDeltaUrl(source: SourceRow, folderId: string): string {
  return `${mailboxPath(source)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${MESSAGE_SELECT}`;
}

type GraphMailFolder = { id: string; childFolderCount?: number };
type DeltaMessage = Partial<GraphMessage> & { id: string; '@removed'?: unknown };

/** Every folder of the mailbox except the excluded well-known ones and their subfolders. */
export async function listMailFolders(source: SourceRow, http: GraphHttpOptions): Promise<string[]> {
  const excluded = new Set<string>();
  for (const name of EXCLUDED_WELL_KNOWN_FOLDERS) {
    try {
      const folder = await graphJson<{ id: string }>(`${mailboxPath(source)}/mailFolders/${name}?$select=id`, http);
      excluded.add(folder.id);
    } catch (error) {
      if (error instanceof GraphHttpError && error.status === 404) continue;
      throw error;
    }
  }

  const ids: string[] = [];
  const queue = [`${mailboxPath(source)}/mailFolders?$select=id,childFolderCount&$top=100`];
  while (queue.length > 0) {
    const url = queue.shift()!;
    for await (const page of graphPages<GraphMailFolder>(url, http)) {
      for (const folder of page.value) {
        if (excluded.has(folder.id)) continue;
        ids.push(folder.id);
        if ((folder.childFolderCount ?? 0) > 0) {
          queue.push(
            `${mailboxPath(source)}/mailFolders/${encodeURIComponent(folder.id)}/childFolders?$select=id,childFolderCount&$top=100`,
          );
        }
      }
    }
  }
  return ids;
}

function toMessage(raw: DeltaMessage): GraphMessage | null {
  // A message without an Internet message id cannot be deduplicated across
  // mailboxes; drafts are the usual case, and their folder is excluded. The
  // id is the sender's to write, so a blank one, or one shaped like a
  // document key (drive:...), is dropped the same way.
  const internetMessageId = raw.internetMessageId?.trim();
  if (raw['@removed'] !== undefined || !internetMessageId || internetMessageId.startsWith('drive:')) return null;
  return {
    id: raw.id,
    internetMessageId,
    conversationId: raw.conversationId ?? null,
    subject: raw.subject ?? null,
    sentDateTime: raw.sentDateTime ?? null,
    receivedDateTime: raw.receivedDateTime ?? null,
    from: raw.from ?? null,
    toRecipients: raw.toRecipients ?? [],
    ccRecipients: raw.ccRecipients ?? [],
    body: raw.body ?? { contentType: 'text', content: '' },
    hasAttachments: raw.hasAttachments ?? false,
  };
}

/** The mail reader's transport: Graph's page size and immutable ids on every request, the binding check's too. */
function mailReaderHttp(http: GraphHttpOptions): GraphHttpOptions {
  return {
    ...http,
    headers: {
      Prefer: `odata.maxpagesize=${MAIL_PAGE_SIZE}, IdType="ImmutableId"`,
      ...(http.headers ?? {}),
    },
  };
}

/**
 * The mailbox key a Graph link addresses, in the plain (/users/x) or the ('x') form, decoded and lowercased; null
 * for a link off Graph or one that names no user.
 */
export function mailboxKeyOfLink(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.origin !== 'https://graph.microsoft.com') return null;
    const match = /^\/v1\.0\/users(?:\('([^']+)'\)|\/([^/(]+))/i.exec(decodeURIComponent(url.pathname));
    return match ? (match[1] ?? match[2]).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The binding check (#275 design R4), before the first page of a live mailbox read: the bound member's inbox, read
 * by its object id and by its UPN, must be the same folder. True only when both answer with the same id. A refusal
 * (403) or an unknown mailbox (404) on either, or an answer without an id, is false. Any other failure is thrown, as
 * from any read: throttling (429), a server error (5xx), a deadline or the network is not evidence about the binding,
 * so it must not show as "Group unreadable". Both requests carry the mail reader's own headers, because a folder id
 * depends on IdType, and go through graphJson, so they inherit the client's retries and deadlines. Only the folder
 * id is selected; nothing is returned.
 */
export async function checkBinding(capability: ReaderCapability, http: GraphHttpOptions, key: ReadKey): Promise<boolean> {
  requireReaderCapability(capability);
  const reader = mailReaderHttp(http);
  const inboxId = async (pathKey: string): Promise<string | null> => {
    try {
      const folder = await graphJson<{ id?: unknown }>(`/users/${encodeURIComponent(pathKey)}/mailFolders/inbox?$select=id`, reader);
      return typeof folder?.id === 'string' && folder.id !== '' ? folder.id : null;
    } catch (error) {
      if (error instanceof GraphHttpError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  };
  const byId = await inboxId(key.id);
  if (byId === null) return false;
  const byUpn = await inboxId(key.upn);
  return byUpn === byId;
}

/**
 * A resume follows the absolute links its checkpoint stored (readFolders below), so a checkpoint written under
 * another path key (the stored address, before #275) would read past the binding. Every stored link must address
 * the bound UPN or object id, in either key form; otherwise this throws, and the source shows "Checkpoint
 * unreadable" (worker/sync.ts errorSummary) until the admin restarts its reading. No checkpoint passes.
 */
export function assertCheckpointKey(checkpoint: string | null, key: ReadKey): void {
  if (!checkpoint) return;
  const accepted = new Set([key.upn.toLowerCase(), key.id.toLowerCase()]);
  for (const folder of parseMailCheckpoint(checkpoint).folders) {
    // A stored checkpoint is not trusted to be well typed: only a string link can address a key.
    const link: unknown = folder.link;
    if (link === null || link === undefined) continue;
    const linkKey = typeof link === 'string' ? mailboxKeyOfLink(link) : null;
    if (linkKey === null || !accepted.has(linkKey)) {
      throw new Error('graph mail reader: the checkpoint addresses another mailbox key');
    }
  }
}

/**
 * Demands the reader capability like the fixture (#262): only
 * src/lib/mailboxAccess/readers.ts holds it, so a live mailbox reader is only
 * ever built behind the guard.
 */
export function createGraphMailContentSource(
  capability: ReaderCapability,
  options: { http: GraphHttpOptions },
): ContentSource {
  requireReaderCapability(capability);
  const http = mailReaderHttp(options.http);

  async function* readFolders(source: SourceRow, state: MailCheckpoint): AsyncIterable<SourceItemPage> {
    for (const folder of state.folders) {
      if (folder.done) continue;
      for await (const page of graphPages<DeltaMessage>(folder.link ?? initialDeltaUrl(source, folder.id), http)) {
        folder.link = page.nextLink ?? page.deltaLink ?? folder.link;
        if (page.deltaLink) folder.done = true;
        state.cycle = cycleOf(state.folders);
        // Every delta object that is not a removal carries its body ($select has body): it crossed the wire,
        // whether or not it is kept (#370 R2-M1).
        const fetched = page.value.filter((raw) => raw['@removed'] === undefined).length;
        const items = page.value.map(toMessage).filter((m): m is GraphMessage => m !== null);
        yield { items, fetched, nextCheckpoint: JSON.stringify(state) };
      }
    }
  }

  return {
    kind: SOURCE_KIND.MAILBOX,

    async *backfill(source, checkpoint) {
      let state: MailCheckpoint;
      if (checkpoint) {
        state = parseMailCheckpoint(checkpoint);
      } else {
        const folders = await listMailFolders(source, http);
        const states = folders.map((id) => ({ id, link: null, done: false }));
        state = { v: 1, kind: 'graph-mail', cycle: cycleOf(states), folders: states };
        // Persist the folder list before any mail, so a resume never re-lists it.
        yield { items: [], nextCheckpoint: JSON.stringify(state) };
      }
      yield* readFolders(source, state);
    },

    async *delta(source, token) {
      const state = parseMailCheckpoint(token);
      const current = await listMailFolders(source, http);
      const known = new Map(state.folders.map((folder) => [folder.id, folder]));
      state.folders = current.map((id) => known.get(id) ?? { id, link: null, done: false });
      // Continue a cycle a job stopped part-way; start the next only once it
      // completed (or nothing is left of it), every folder from its deltaLink.
      if (state.cycle !== 'running' || state.folders.every((folder) => folder.done)) {
        state.folders = state.folders.map((folder) => ({ ...folder, done: false }));
      }
      state.cycle = cycleOf(state.folders);
      yield* readFolders(source, state);
    },
  };
}
