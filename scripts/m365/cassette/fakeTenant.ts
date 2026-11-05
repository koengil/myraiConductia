// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The corpus comes through that module.
import { loadFixtureCorpus, type GraphMessage } from '../../../src/lib/mailboxAccess/readers';

import { createHash } from 'node:crypto';

import { FIXTURE_PAGE_SIZE, SOURCE_KIND } from '../../../src/lib/constants/discovery';
import type { CassetteSource } from './format';

// A fake Microsoft Graph tenant (CDT-277): the bank.example fixture mailboxes
// served in Graph's wire shape, so the real readers can be recorded without a
// live tenant. It generates the committed synthetic cassette and is the
// recorder's test double.
//
// It also serves one SharePoint site with one library: a folder, a PDF, a text
// file and an image (which the reader never downloads). A file's bytes come
// through Graph's real shape: a 302 from /items/<id>/content to a
// pre-authenticated download URL on another host.
//
// A second site (its own library and memo) is served only with the `secondSite` option, for a recording of two
// sites (#318); the default tenant, and so the synthetic cassette, is unchanged.
//
// It also seeds fake secrets, so every CI run proves the scrub on the committed cassette: a JWT in a
// canary header and in every download URL's tempauth, correlation ids and a throttle scope on Graph
// responses, and one 429 that the reader retries. None of them may reach the cassette.
//
// It also serves the Exchange scope group's direct members (#275, design R8) for
// the group mirror's tests: the bank.example users, one shared mailbox whose UPN
// is on the onmicrosoft domain, a nested group and a contact (skipped), and the
// binding hazards, over two pages. For the live reader's binding check (#275
// slice 4) a mailbox also answers by its member's object id, its inbox answers
// by name, and the shared mailbox (no mail) answers by its UPN. The synthetic
// cassette never requests /groups, an object id, the inbox by name or the shared
// mailbox, so it is unchanged.
//
// All messages of a mailbox sit in `inbox`, in fixture order, FIXTURE_PAGE_SIZE
// per page. That keeps the worker's forward-only routing (which learns per page)
// identical to the fixture reader's, so replay reproduces its totals.

export const FAKE_GRAPH = 'https://graph.microsoft.com/v1.0';
const JSON_TYPE = 'application/json; odata.metadata=minimal';

export const FAKE_SITE_ADDRESS = 'bank.sharepoint.com:/sites/Deals'; // passes write-registration's SITE regex
const SITE_ID = 'bank.sharepoint.com,00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002';
const DRIVE_ID = 'D-deals';
const SHAREPOINT_ORIGIN = 'https://bank.sharepoint.com';
const DOWNLOAD_PATH = '/_layouts/15/download.aspx';
const MODIFIED = '2026-02-21T10:00:00Z';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const FAKE_TENANT_GUID = '00000000-0000-4000-8000-00000000000a';
const FAKE_APP_GUID = '00000000-0000-4000-8000-00000000000b';
/** A JWT-shaped seeded secret. It starts with eyJ, as a real access token does. */
export const FAKE_JWT = `${b64url({ typ: 'JWT', alg: 'RS256' })}.${b64url({ aud: 'fake', tid: FAKE_TENANT_GUID })}.${Buffer.from('fake-signature-not-a-real-key').toString('base64url')}`;
/** The one mailbox whose first inbox delta request is throttled once. */
const THROTTLED_MAILBOX = 'storm.duncan@bank.example';

/** A one-page PDF with a text layer (a copy of tests/graph/reader-drive.test.ts, which a script cannot import). */
function syntheticPdf(text: string): Buffer {
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

type FakeFile = { id: string; name: string; mimeType: string; folder: string; bytes: Buffer | null };

// Page 1 of the library: the root folder (dropped by the reader) and the teaser.
// Page 2: the menu, the logo and the teaser AGAIN (same cTag). Graph documents that a driveItem can
// appear more than once in a delta feed; the reader downloads each appearance, and each download gets
// its own 302 with a new Location (a new tempauth live). Then a delta that answers no change.
const FILES: FakeFile[] = [
  { id: 'falcon-teaser', name: 'Falcon teaser.pdf', mimeType: 'application/pdf', folder: 'Falcon', bytes: syntheticPdf('Project Falcon teaser, draft 2') },
  { id: 'canteen-menu', name: 'Canteen menu.txt', mimeType: 'text/plain', folder: '', bytes: Buffer.from('Soup of the day.') },
  { id: 'logo', name: 'logo.png', mimeType: 'image/png', folder: '', bytes: null }, // image_only: never downloaded
];
const LOGO_SIZE = 2048;
const DRIVE_PAGES: string[][] = [['root', 'falcon-teaser'], ['canteen-menu', 'logo', 'falcon-teaser']];

// A second site, only when asked (FakeTenantOptions.secondSite): its own site id, library and file, so a recording of
// two sites holds two different downloads. One page: the root folder and the memo, then a delta that answers no change.
export const FAKE_SECOND_SITE_ADDRESS = 'bank.sharepoint.com:/sites/Legal';
const SECOND_SITE_ID = 'bank.sharepoint.com,00000000-0000-4000-8000-000000000003,00000000-0000-4000-8000-000000000004';
const SECOND_DRIVE_ID = 'D-legal';
const SECOND_FILE: FakeFile = { id: 'legal-memo', name: 'Legal memo.txt', mimeType: 'text/plain', folder: '', bytes: Buffer.from('Counsel memo, draft 1.') };

function driveItem(id: string): Record<string, unknown> {
  if (id === 'root') {
    return { id, name: 'root', folder: { childCount: FILES.length }, parentReference: { driveId: DRIVE_ID }, lastModifiedDateTime: MODIFIED };
  }
  const file = FILES.find((f) => f.id === id)!;
  return {
    id,
    name: file.name,
    size: file.bytes?.length ?? LOGO_SIZE,
    file: { mimeType: file.mimeType },
    parentReference: { driveId: DRIVE_ID, path: `/drives/${DRIVE_ID}/root:${file.folder ? `/${file.folder}` : ''}` },
    lastModifiedDateTime: MODIFIED,
    createdBy: { user: { email: 'storm.duncan@bank.example', displayName: 'Storm Duncan' } },
    cTag: `c-${id}`,
    eTag: `e-${id}`,
  };
}

const opaque = (seed: string) =>
  `${createHash('sha256').update(seed).digest('base64url')}${createHash('sha256').update(`~${seed}`).digest('base64url')}`;

const slug = (address: string) => createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 8);

type Mailbox = { address: string; messages: GraphMessage[] };

const FOLDER_NAMES = ['inbox', 'archive', 'sentitems', 'deleteditems', 'junkemail'] as const;
type FolderName = (typeof FOLDER_NAMES)[number];

/** The well-known names the reader looks up (to exclude them); those the fake has answer with an id, the rest 404. */
const WELL_KNOWN_LOOKUPS = new Set<string>(['deleteditems', 'junkemail', 'drafts', 'outbox', 'recoverableitemsdeletions']);
const WELL_KNOWN_PRESENT = new Set<string>(['deleteditems', 'junkemail']);

const folderId = (address: string, name: FolderName) => `AAMkFolder${slug(address)}${name}`;

function mailboxes(): Mailbox[] {
  return loadFixtureCorpus()
    .map((file) => ({ address: file.mailbox, messages: file.messages }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

/** Three mailboxes and one site, sorted by address (the site lands between alex and morgan). */
export function fakeTenantSources(): CassetteSource[] {
  const sources: CassetteSource[] = [
    ...mailboxes().map((box) => ({ kind: SOURCE_KIND.MAILBOX, address: box.address })),
    { kind: SOURCE_KIND.SHAREPOINT_SITE, address: FAKE_SITE_ADDRESS },
  ];
  return sources.sort((a, b) => a.address.localeCompare(b.address));
}

/** The Exchange scope group's Entra object id (graph_reader_registrations.scope_group_id). */
export const FAKE_GROUP_ID = '00000000-0000-4000-8000-0000000000c0';
const memberId = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

/** A user member as Graph lists it. Mail and UPN as the directory holds them: the mirror lowercases. */
type FakeUser = { id: string; mail: string; upn: string };

/** The shared mailbox (a team inbox): its mail is the team address, its UPN is on the onmicrosoft domain. */
export const FAKE_SHARED_MAILBOX: FakeUser = { id: memberId(90), mail: 'deals@bank.example', upn: 'deals@bankexample.onmicrosoft.com' };
/**
 * The binding hazards (design R4). UPN_DIFFERS has a UPN that is not its mail; UPN_IS_OTHERS_MAIL has a UPN equal
 * to UPN_DIFFERS's mail, so that address is ambiguous; UPN_ONLY's UPN is no member's mail, so an allowlisted UPN_ONLY
 * UPN binds through a UPN only and is ambiguous too.
 */
export const FAKE_GROUP_HAZARDS = {
  UPN_DIFFERS: { id: memberId(91), mail: 'jordan.ellis@bank.example', upn: 'jordan.ellis@bankexample.onmicrosoft.com' },
  UPN_IS_OTHERS_MAIL: { id: memberId(92), mail: 'j.ellis@bank.example', upn: 'jordan.ellis@bank.example' },
  UPN_ONLY: { id: memberId(93), mail: 'quinn.shaw@bank.example', upn: 'quinn@bank.example' },
} satisfies Record<string, FakeUser>;

/**
 * Switches for the group mirror's tests: the fields a role that returns too little would leave out (design R1), and,
 * for the binding check (design R4), an inbox that answers another folder id by object id than by UPN.
 */
export type FakeTenantOptions = {
  strip?: 'mail' | 'mailAndUpn';
  mismatchInboxById?: boolean;
  /** Mail paging links (nextLink, deltaLink) address the mailbox by its object id, in Graph's /users/<id> or /users('<id>') form (#318). */
  linksByObjectId?: 'path' | 'paren';
  /** Also serve FAKE_SECOND_SITE_ADDRESS, a site with its own library and file (#318, a recording of two sites). */
  secondSite?: boolean;
};

/** Each fixture mailbox as a group user, mail and UPN alike; the first in upper case, as a directory may hold it. */
function fixtureGroupUsers(): FakeUser[] {
  return mailboxes().map((box, i): FakeUser => {
    const address = i === 0 ? box.address.toUpperCase() : box.address;
    return { id: memberId(i + 1), mail: address, upn: address };
  });
}

/** The group's user members: the fixture mailboxes, the shared mailbox, then the hazards. The same ids on every call. */
export function fakeGroupUsers(): FakeUser[] {
  return [...fixtureGroupUsers(), FAKE_SHARED_MAILBOX, ...Object.values(FAKE_GROUP_HAZARDS)];
}

type PageState =
  | { kind: 'skip'; address: string; folder: FolderName; offset: number }
  | { kind: 'delta'; address: string; folder: FolderName }
  | { kind: 'drive-skip'; page: number }
  | { kind: 'drive-delta' }
  | { kind: 'group-page'; page: number };

export function createFakeTenant(options: FakeTenantOptions = {}): { fetch: typeof fetch; requests: string[] } {
  const boxes = new Map(mailboxes().map((box) => [box.address.toLowerCase(), box]));
  // The shared mailbox holds no mail, under its UPN: the path key a read of it uses (design R4, R12).
  boxes.set(FAKE_SHARED_MAILBOX.upn, { address: FAKE_SHARED_MAILBOX.upn, messages: [] });
  // Graph's other path key: each group user's object id names the mailbox its UPN does.
  const byObjectId = new Map(fakeGroupUsers().map((user) => [user.id.toLowerCase(), user.upn.toLowerCase()]));
  const tokens = new Map<string, PageState>();
  const requests: string[] = [];
  let responses = 0;
  let throttled = false;
  let contentRequests = 0;

  // Graph's correlation headers on every JSON response: deterministic GUIDs from a counter.
  const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const json = (body: unknown, status = 200) => {
    responses += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': JSON_TYPE,
        'request-id': guid(responses),
        'client-request-id': guid(responses),
        'x-ms-ags-diagnostic': `{"ServerInfo":{"DataCenter":"West US","Slice":"E","Ring":"5","ScaleUnit":"001","RoleInstance":"BL2PEPF0000${responses}"}}`,
      },
    });
  };
  // Graph's error body carries a message and an innerError with a per-call date and correlation ids.
  // Scrub reduces it to the code, or the same 404 requested twice would differ.
  const notFound = () =>
    json(
      {
        error: {
          code: 'ErrorItemNotFound',
          message: 'The specified object was not found in the store.',
          innerError: {
            date: new Date(Date.UTC(2026, 8, 29, 0, 0, responses + 1)).toISOString(),
            'request-id': guid(responses + 1),
            'client-request-id': guid(responses + 1),
          },
        },
      },
      404,
    );

  const idByUpn = new Map(fakeGroupUsers().map((user) => [user.upn.toLowerCase(), user.id]));
  // A paging link names the mailbox as the reader did, or by its object id when the tenant is set to.
  const userPath = (address: string) => {
    const id = options.linksByObjectId ? idByUpn.get(address.toLowerCase()) : undefined;
    if (id === undefined) return `/users/${encodeURIComponent(address)}`;
    return options.linksByObjectId === 'paren' ? `/users('${id}')` : `/users/${id}`;
  };
  const deltaPath = (address: string, folder: FolderName) =>
    `${FAKE_GRAPH}${userPath(address)}/mailFolders/${encodeURIComponent(folderId(address, folder))}/messages/delta`;

  const drivePath = `${FAKE_GRAPH}/drives/${DRIVE_ID}/root/delta`;

  const groupPath = `${FAKE_GRAPH}/groups/${FAKE_GROUP_ID}/members`;

  function link(state: PageState): string {
    if (state.kind === 'group-page') {
      const token = opaque(`group-page:${state.page}`);
      tokens.set(token, state);
      return `${groupPath}?$select=id,mail,userPrincipalName&$top=999&$skiptoken=${token}`;
    }
    if (state.kind === 'drive-skip' || state.kind === 'drive-delta') {
      const token = opaque(state.kind === 'drive-skip' ? `drive-skip:${state.page}` : 'drive-delta');
      tokens.set(token, state);
      return `${drivePath}?token=${token}`;
    }
    const seed = state.kind === 'skip' ? `skip:${state.address}:${state.folder}:${state.offset}` : `delta:${state.address}:${state.folder}`;
    const token = opaque(seed);
    tokens.set(token, state);
    const param = state.kind === 'skip' ? '$skiptoken' : '$deltatoken';
    return `${deltaPath(state.address, state.folder)}?${param}=${token}`;
  }

  /** One page of the library: a nextLink while more remain, else the deltaLink. */
  function drivePage(index: number) {
    const body: Record<string, unknown> = { value: DRIVE_PAGES[index].map(driveItem) };
    if (index + 1 < DRIVE_PAGES.length) body['@odata.nextLink'] = link({ kind: 'drive-skip', page: index + 1 });
    else body['@odata.deltaLink'] = link({ kind: 'drive-delta' });
    return json(body);
  }

  /** The SharePoint side: the site, its libraries, the delta, and the 302 to a download URL. */
  function sharepoint(path: string, url: URL): Response | null {
    if (path === `/sites/${FAKE_SITE_ADDRESS}`) return json({ id: SITE_ID });
    if (path === `/sites/${SITE_ID}/drives`) return json({ value: [{ id: DRIVE_ID, name: 'Documents' }] });
    if (path === `/drives/${DRIVE_ID}/root/delta`) {
      const token = url.searchParams.get('token');
      if (!token) return drivePage(0);
      const state = tokens.get(token);
      if (state?.kind === 'drive-skip') return drivePage(state.page);
      if (state?.kind === 'drive-delta') return json({ value: [], '@odata.deltaLink': link(state) });
      return notFound();
    }
    const content = new RegExp(`^/drives/${DRIVE_ID}/items/([^/]+)/content$`).exec(path);
    if (content) {
      const file = FILES.find((f) => f.id === content[1]);
      if (!file?.bytes) return notFound();
      // hop counts the content requests, so a repeated item gets a different Location each time.
      contentRequests += 1;
      return new Response(null, {
        status: 302,
        headers: {
          // A live pre-authenticated URL carries a tempauth credential; this one is seeded with a fake.
          location: `${SHAREPOINT_ORIGIN}${DOWNLOAD_PATH}?UniqueId=${encodeURIComponent(file.id)}&hop=${contentRequests}&tempauth=${FAKE_JWT}`,
        },
      });
    }
    return null;
  }

  /** The second site (FakeTenantOptions.secondSite): the same four calls as the first, over its own library and memo. */
  function secondSite(path: string, url: URL): Response | null {
    if (!options.secondSite) return null;
    if (path === `/sites/${FAKE_SECOND_SITE_ADDRESS}`) return json({ id: SECOND_SITE_ID });
    if (path === `/sites/${SECOND_SITE_ID}/drives`) return json({ value: [{ id: SECOND_DRIVE_ID, name: 'Documents' }] });
    if (path === `/drives/${SECOND_DRIVE_ID}/root/delta`) {
      const token = opaque('drive2-delta');
      const deltaLink = `${FAKE_GRAPH}/drives/${SECOND_DRIVE_ID}/root/delta?token=${token}`;
      const asked = url.searchParams.get('token');
      if (asked) return asked === token ? json({ value: [], '@odata.deltaLink': deltaLink }) : notFound();
      const memo = SECOND_FILE.bytes!;
      return json({
        value: [
          { id: 'root', name: 'root', folder: { childCount: 1 }, parentReference: { driveId: SECOND_DRIVE_ID }, lastModifiedDateTime: MODIFIED },
          {
            id: SECOND_FILE.id,
            name: SECOND_FILE.name,
            size: memo.length,
            file: { mimeType: SECOND_FILE.mimeType },
            parentReference: { driveId: SECOND_DRIVE_ID, path: `/drives/${SECOND_DRIVE_ID}/root:` },
            lastModifiedDateTime: MODIFIED,
            createdBy: { user: { email: 'storm.duncan@bank.example', displayName: 'Storm Duncan' } },
            cTag: `c-${SECOND_FILE.id}`,
            eTag: `e-${SECOND_FILE.id}`,
          },
        ],
        '@odata.deltaLink': deltaLink,
      });
    }
    if (path === `/drives/${SECOND_DRIVE_ID}/items/${SECOND_FILE.id}/content`) {
      contentRequests += 1; // shared with the first site's, so every download gets its own Location
      return new Response(null, {
        status: 302,
        headers: {
          location: `${SHAREPOINT_ORIGIN}${DOWNLOAD_PATH}?UniqueId=${encodeURIComponent(SECOND_FILE.id)}&hop=${contentRequests}&tempauth=${FAKE_JWT}`,
        },
      });
    }
    return null;
  }

  /** A user as Graph lists it, less the fields the options strip. */
  const groupUser = (user: FakeUser) => ({
    '@odata.type': '#microsoft.graph.user',
    id: user.id,
    ...(options.strip ? {} : { mail: user.mail }),
    ...(options.strip === 'mailAndUpn' ? {} : { userPrincipalName: user.upn }),
  });

  /**
   * The scope group's direct members, two pages. Page 1: the first fixture user, a nested group, the shared mailbox
   * and the remaining fixture users. Page 2: a contact, then the hazards.
   */
  function group(path: string, url: URL): Response | null {
    if (path !== `/groups/${FAKE_GROUP_ID}/members`) return path.startsWith('/groups/') ? notFound() : null;
    const token = url.searchParams.get('$skiptoken');
    if (!token) {
      const [first, ...rest] = fixtureGroupUsers();
      return json({
        value: [
          groupUser(first),
          { '@odata.type': '#microsoft.graph.group', id: memberId(80), mail: 'deal-team@bank.example' },
          groupUser(FAKE_SHARED_MAILBOX),
          ...rest.map(groupUser),
        ],
        '@odata.nextLink': link({ kind: 'group-page', page: 1 }),
      });
    }
    if (tokens.get(token)?.kind !== 'group-page') return notFound();
    return json({
      value: [
        { '@odata.type': '#microsoft.graph.orgContact', id: memberId(81), mail: 'adviser@counsel.example' },
        ...Object.values(FAKE_GROUP_HAZARDS).map(groupUser),
      ],
    });
  }

  /** One page of a folder's messages from `offset`: a nextLink while more remain, else the deltaLink. */
  function page(box: Mailbox, folder: FolderName, offset: number) {
    const all = folder === 'inbox' ? box.messages : [];
    const end = Math.min(offset + FIXTURE_PAGE_SIZE, all.length);
    const body: Record<string, unknown> = { value: all.slice(offset, end) };
    if (end < all.length) body['@odata.nextLink'] = link({ kind: 'skip', address: box.address, folder, offset: end });
    else body['@odata.deltaLink'] = link({ kind: 'delta', address: box.address, folder });
    return json(body);
  }

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = input instanceof Request ? input.url : String(input);
    requests.push(raw);
    if (method !== 'GET') return json({ error: { code: 'ErrorInvalidMethod' } }, 405);

    const url = new URL(raw);
    // The pre-authenticated download URL: another host, no bearer token.
    if (url.origin === SHAREPOINT_ORIGIN && url.pathname === DOWNLOAD_PATH) {
      const file = (options.secondSite ? [...FILES, SECOND_FILE] : FILES).find((f) => f.id === url.searchParams.get('UniqueId'));
      if (!file?.bytes) return notFound();
      return new Response(new Uint8Array(file.bytes), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(file.bytes.length),
          sprequestguid: guid(9000),
        },
      });
    }
    if (url.origin !== 'https://graph.microsoft.com') return notFound();
    const path = decodeURIComponent(url.pathname).replace(/^\/v1\.0/, '');

    const site = sharepoint(path, url);
    if (site) return site;
    const second = secondSite(path, url);
    if (second) return second;

    const members = group(path, url);
    if (members) return members;

    const mail = /^\/users(?:\/([^/(]+)|\('([^']+)'\))\/mailFolders(?:\/([^/]+)(?:\/(childFolders|messages\/delta))?)?$/.exec(path);
    if (!mail) return notFound();
    const key = mail[1] ?? mail[2];
    const objectId = byObjectId.get(key.toLowerCase());
    const box = boxes.get(objectId ?? key.toLowerCase());
    if (!box) return notFound();
    const [, , , segment, tail] = mail;

    // /mailFolders/inbox?$select=id: the binding check's request, by object id and by UPN (design R4). The reader
    // itself never asks for the inbox by name.
    if (!tail && segment === 'inbox') {
      const id = folderId(box.address, 'inbox');
      return json({ id: objectId !== undefined && options.mismatchInboxById ? `${id}-other` : id });
    }

    // /mailFolders: the top-level folders.
    if (!segment) {
      return json({
        value: [
          { id: folderId(box.address, 'inbox'), childFolderCount: 1 },
          { id: folderId(box.address, 'sentitems'), childFolderCount: 0 },
          { id: folderId(box.address, 'deleteditems'), childFolderCount: 0 },
          { id: folderId(box.address, 'junkemail'), childFolderCount: 0 },
        ],
      });
    }

    // /mailFolders/<well-known name>?$select=id
    if (!tail && WELL_KNOWN_LOOKUPS.has(segment)) {
      return WELL_KNOWN_PRESENT.has(segment) ? json({ id: folderId(box.address, segment as FolderName) }) : notFound();
    }

    const folder = FOLDER_NAMES.find((name) => folderId(box.address, name) === segment);
    if (!folder) return notFound();

    if (tail === 'childFolders') {
      return json({ value: folder === 'inbox' ? [{ id: folderId(box.address, 'archive'), childFolderCount: 0 }] : [] });
    }

    if (tail === 'messages/delta') {
      const skip = url.searchParams.get('$skiptoken');
      const delta = url.searchParams.get('$deltatoken');
      if (skip) {
        const state = tokens.get(skip);
        return state?.kind === 'skip' && state.folder === folder ? page(box, folder, state.offset) : notFound();
      }
      if (delta) {
        const state = tokens.get(delta);
        if (state?.kind !== 'delta' || state.folder !== folder) return notFound();
        return json({ value: [], '@odata.deltaLink': link(state) });
      }
      // The first inbox delta request of one mailbox is throttled once; the reader retries it.
      if (!throttled && folder === 'inbox' && box.address.toLowerCase() === THROTTLED_MAILBOX) {
        throttled = true;
        const res = json({ error: { code: 'TooManyRequests', message: 'Please retry after a short wait.' } }, 429);
        res.headers.set('retry-after', '0');
        res.headers.set('x-ms-throttle-scope', `Tenant_Application/ReadOnly/${FAKE_APP_GUID}/${FAKE_TENANT_GUID}`);
        return res;
      }
      return page(box, folder, 0);
    }

    return notFound();
  }) as typeof fetch;

  // The first response carries a canary credential header, to prove headers are allowlisted, not blocklisted.
  let first = true;
  const seeded = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await impl(input, init);
    if (first) {
      first = false;
      res.headers.set('x-canary-authorization', `Bearer ${FAKE_JWT}`);
    }
    return res;
  }) as typeof fetch;

  return { fetch: seeded, requests };
}
