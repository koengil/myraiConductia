// @vitest-environment node
// The upload route parses multipart with Request#formData(), which never
// settles against jsdom's Blob implementation. These are server-route tests;
// node is also the runtime they ship on.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(() => Promise.resolve(null)),
  isFlagEnabled: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/storage', () => ({
  getDataRoomStorage: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { getDataRoomStorage } from '@/lib/storage';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import {
  userCanListDocument,
  userCanListDocumentName,
  userCanOpenDocument,
  userCanUploadDocument,
  type DocumentGate,
  type DocumentViewer,
} from '@/lib/api/v1/documentAccess';
import { GET as DOWNLOAD } from '@/app/api/v1/deals/[dealId]/documents/[documentId]/download/route';
import { POST as VIEW } from '@/app/api/v1/deals/[dealId]/documents/[documentId]/view/route';

/*
 * THE wall (spec-v3 criteria 7–8): external users never reach the internal
 * room or MNPI, phase gates staged disclosure, and direct-ID probes learn
 * nothing. Pure-function matrix first, then the route-level anti-oracle.
 */

const md: DocumentViewer = {
  userId: 'md',
  isExternal: false,
  hasOversight: false,
  dealRole: 'md',
  phase: 0,
};
const dealTeam: DocumentViewer = { ...md, userId: 'dt', dealRole: 'deal_team' };
const readOnly: DocumentViewer = { ...md, userId: 'ro', dealRole: 'read_only' };
const cco: DocumentViewer = {
  userId: 'cco',
  isExternal: false,
  hasOversight: true,
  dealRole: null,
  phase: 0,
};
const sellerP1: DocumentViewer = {
  userId: 's',
  isExternal: true,
  hasOversight: false,
  dealRole: 'seller',
  phase: 1,
};
const buyerP0: DocumentViewer = { ...sellerP1, userId: 'b', dealRole: 'buyer', phase: 0 };
const buyerP2: DocumentViewer = { ...buyerP0, phase: 2 };

const internalDoc: DocumentGate = { room: 'internal', classification: 2, min_phase: 0 };
const mnpiDeal: DocumentGate = { room: 'deal', classification: 4, min_phase: 0 };
const dealPhase2: DocumentGate = { room: 'deal', classification: 2, min_phase: 2 };
const dealOpen: DocumentGate = { room: 'deal', classification: 2, min_phase: 0 };
const dealConfidential: DocumentGate = { room: 'deal', classification: 3, min_phase: 0 };

describe('userCanListDocument — filename index', () => {
  it('external users see deal-room filenames but never internal-room names', () => {
    expect(userCanListDocument(buyerP0, dealPhase2)).toBe(true);
    expect(userCanListDocument(buyerP0, internalDoc)).toBe(false);
    expect(userCanListDocument(md, internalDoc)).toBe(true);
  });
});

describe('userCanListDocumentName — class-4 titles (D1 = B, #78)', () => {
  const mnpiInternal: DocumentGate = { room: 'internal', classification: 4, min_phase: 0 };
  const legal: DocumentViewer = { ...md, userId: 'lg', dealRole: 'legal' };

  it('class-4 names reach only the deal MD and oversight', () => {
    for (const doc of [mnpiDeal, mnpiInternal]) {
      expect(userCanListDocumentName(md, doc)).toBe(true);
      expect(userCanListDocumentName(cco, doc)).toBe(true);
      for (const viewer of [dealTeam, legal, readOnly, sellerP1, buyerP2]) {
        expect(userCanListDocumentName(viewer, doc)).toBe(false);
      }
    }
  });

  it('class 1-3 names are not touched by this wall (the room wall still applies)', () => {
    for (const doc of [internalDoc, dealOpen, dealConfidential, dealPhase2]) {
      for (const viewer of [md, cco, dealTeam, legal, readOnly, sellerP1, buyerP0]) {
        expect(userCanListDocumentName(viewer, doc)).toBe(true);
      }
    }
  });

  it('never lists a name that cannot be opened for MNPI reasons', () => {
    for (const viewer of [md, cco, dealTeam, legal, readOnly, sellerP1, buyerP2]) {
      if (!userCanListDocumentName(viewer, mnpiDeal)) {
        expect(userCanOpenDocument(viewer, mnpiDeal)).toBe(false);
      }
    }
  });
});

describe('userCanOpenDocument — the wall matrix', () => {
  it('external users NEVER open the internal room, at any phase or seat', () => {
    for (const viewer of [sellerP1, buyerP0, buyerP2]) {
      expect(userCanOpenDocument(viewer, internalDoc)).toBe(false);
      expect(userCanOpenDocument({ ...viewer, phase: 99 }, internalDoc)).toBe(false);
    }
  });

  it('MNPI (classification 4) is md/cco only — deal_team and externals excluded', () => {
    expect(userCanOpenDocument(md, mnpiDeal)).toBe(true);
    expect(userCanOpenDocument(cco, mnpiDeal)).toBe(true);
    expect(userCanOpenDocument(dealTeam, mnpiDeal)).toBe(false);
    expect(userCanOpenDocument(sellerP1, mnpiDeal)).toBe(false);
    expect(userCanOpenDocument(buyerP2, mnpiDeal)).toBe(false);
  });

  it('phase gates external viewers only', () => {
    expect(userCanListDocument(buyerP0, dealPhase2)).toBe(true);
    expect(userCanOpenDocument(buyerP0, dealPhase2)).toBe(false);
    expect(userCanOpenDocument(buyerP2, dealPhase2)).toBe(true);
    expect(userCanOpenDocument(md, dealPhase2)).toBe(true);
  });

  it('open deal-room documents reach every seat at class 2', () => {
    for (const viewer of [md, dealTeam, cco, sellerP1, buyerP0, readOnly]) {
      expect(userCanOpenDocument(viewer, dealOpen)).toBe(true);
    }
  });

  it('classification ceiling blocks read_only from class 3', () => {
    expect(userCanOpenDocument(readOnly, dealConfidential)).toBe(false);
    expect(userCanOpenDocument(dealTeam, dealConfidential)).toBe(true);
    expect(userCanOpenDocument(md, dealConfidential)).toBe(true);
  });
});

describe('userCanUploadDocument', () => {
  it('buyers never upload; sellers upload deal-room class 1-3 only', () => {
    expect(userCanUploadDocument(buyerP2, 'deal', 2)).toBe(false);
    expect(userCanUploadDocument(sellerP1, 'deal', 3)).toBe(true);
    expect(userCanUploadDocument(sellerP1, 'deal', 4)).toBe(false);
    expect(userCanUploadDocument(sellerP1, 'internal', 2)).toBe(false);
  });

  it('internal staff upload to both rooms; MNPI authorship is md/cco only', () => {
    expect(userCanUploadDocument(dealTeam, 'internal', 3)).toBe(true);
    expect(userCanUploadDocument(dealTeam, 'deal', 2)).toBe(true);
    expect(userCanUploadDocument(dealTeam, 'internal', 4)).toBe(false);
    expect(userCanUploadDocument(md, 'internal', 4)).toBe(true);
  });
});

/* ---------------- route-level anti-oracle ---------------- */

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  // Routes resolve the deal code/UUID first; default the read so tests
  // that never assert on deals don't have to stub it.
  if (!('deals' in tables)) tables.deals = { data: { id: 'd1', code: 'PRJRA' }, error: null };
  const inserts: Array<{ table: string; row: unknown }> = [];
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.eq = chain;
    builder.order = chain;
    builder.limit = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.insert = (row: unknown) => {
      inserts.push({ table, row });
      return builder;
    };
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  return {
    admin: { from } as unknown as ReturnType<typeof createSupabaseAdminClient>,
    inserts,
  };
}

function signedIn(admin: ReturnType<typeof createSupabaseAdminClient>, userId: string) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: userId, email: `${userId}@x.co` } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

const activeStatus: Resp = { data: { status: 'active' }, error: null };
const externalProfile: Resp = { data: { is_external: true, firm_role: null }, error: null };
const buyerSeat: Resp = { data: { deal_role: 'buyer', phase: 0 }, error: null };
const anyMembership: Resp = { data: { deal_role: 'buyer' }, error: null };

function ctx() {
  return { params: Promise.resolve({ dealId: 'd1', documentId: 'doc1' }) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('download route — direct-ID probes learn nothing', () => {
  it('404s an internal-room document for an external buyer (same as missing)', async () => {
    const { admin, inserts } = makeAdmin({
      // requireApiUser status probe; userCanAccessDeal membership;
      // getDocumentViewer profile + membership; document row.
      // 1: requireApiUser status; 2: userCanAccessDeal firm_role probe;
      // 3: getDocumentViewer profile.
      users: [activeStatus, externalProfile, externalProfile],
      deal_memberships: [anyMembership, buyerSeat],
      documents: {
        data: {
          id: 'doc1',
          deal_id: 'd1',
          name: 'Bank internal memo',
          room: 'internal',
          classification: 2,
          min_phase: 0,
          storage_file_id: 'f1',
          content_type: 'text/plain',
        },
        error: null,
      },
    });
    signedIn(admin, 'buyer-1');
    const res = await DOWNLOAD(new Request('http://x/download'), ctx());
    expect(res.status).toBe(404);
    // And crucially: no download audit row for a walled-off request.
    expect(inserts.filter((i) => i.table === 'audit_log')).toHaveLength(0);
  });

  it('502s (retryable) when storage is down — after access passed', async () => {
    const { admin } = makeAdmin({
      // 1: requireApiUser status; 2: userCanAccessDeal firm_role probe;
      // 3: getDocumentViewer profile.
      users: [activeStatus, externalProfile, externalProfile],
      deal_memberships: [anyMembership, buyerSeat],
      documents: {
        data: {
          id: 'doc1',
          deal_id: 'd1',
          name: 'CIM.pdf',
          room: 'deal',
          classification: 2,
          min_phase: 0,
          storage_file_id: 'f1',
          content_type: 'application/pdf',
        },
        error: null,
      },
      audit_log: { data: { id: 'a1' }, error: null },
    });
    signedIn(admin, 'buyer-1');
    vi.mocked(getDataRoomStorage).mockReturnValue({
      provider: 'box',
      upload: vi.fn(),
      downloadStream: vi.fn(() => Promise.reject(new Error('box 503'))),
      remove: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await DOWNLOAD(new Request('http://x/download'), ctx());
    expect(res.status).toBe(502);
  });
});

describe('view route — the audit path is walled too (cr-plan-v1 1.2)', () => {
  it('404s a view attempt on an MNPI document by an external buyer', async () => {
    const { admin, inserts } = makeAdmin({
      // 1: requireApiUser status; 2: userCanAccessDeal firm_role probe;
      // 3: getDocumentViewer profile.
      users: [activeStatus, externalProfile, externalProfile],
      deal_memberships: [anyMembership, buyerSeat],
      documents: {
        data: {
          id: 'doc1',
          deal_id: 'd1',
          name: 'Board minutes',
          room: 'deal',
          classification: 4,
          min_phase: 0,
        },
        error: null,
      },
    });
    signedIn(admin, 'buyer-1');
    const res = await VIEW(new Request('http://x/view', { method: 'POST' }), ctx());
    expect(res.status).toBe(404);
    expect(inserts.filter((i) => i.table === 'audit_log')).toHaveLength(0);
  });
});

/* -------- upload atomicity: RPC row+audit + compensation (cr-prr-124 3.1) -------- */

import { GET as LIST, POST as UPLOAD } from '@/app/api/v1/deals/[dealId]/documents/route';
import { DOCUMENT_MAX_BYTES } from '@/lib/validation/inputPolicy';

function uploadRequest() {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([1, 2, 3])], 'cim.pdf', { type: 'application/pdf' }));
  form.set('room', 'deal');
  form.set('classification', '2');
  return new Request('http://localhost/api/v1/deals/d1/documents', { method: 'POST', body: form });
}

function uploaderTables(): Record<string, Resp | Resp[]> {
  return {
    // requireApiUser status probe, access firm_role probe, viewer profile.
    users: [
      activeStatus,
      { data: { firm_role: null }, error: null },
      { data: { is_external: false, firm_role: null }, error: null },
    ],
    deal_memberships: [
      { data: { deal_role: 'md' }, error: null },
      { data: { deal_role: 'md', phase: 0 }, error: null },
    ],
    deals: { data: { code: 'PRJRA' }, error: null },
  };
}

describe('upload route — transactional row+audit with storage compensation', () => {
  afterEach(() => vi.clearAllMocks());

  it('compensates the stored object and returns 500 when the RPC fails', async () => {
    const { admin, inserts } = makeAdmin(uploaderTables());
    const remove = vi.fn(() => Promise.resolve());
    vi.mocked(getDataRoomStorage).mockReturnValue({
      provider: 'local',
      upload: vi.fn(() =>
        Promise.resolve({ provider: 'local', fileId: 'f-1', sizeBytes: 3 }),
      ),
      downloadStream: vi.fn(),
      remove,
    } as never);
    (admin as { rpc?: unknown }).rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'audit insert failed' } }),
    );
    signedIn(admin, 'md');

    const res = await UPLOAD(uploadRequest(), { params: Promise.resolve({ dealId: 'd1' }) });
    expect(res.status).toBe(500);
    // The object never outlives the failed transaction, and no direct table
    // insert bypassed the RPC.
    expect(remove).toHaveBeenCalledWith('f-1');
    expect(inserts).toHaveLength(0);
  });

  it('refuses an unknown Deal Folder destination before storage runs', async () => {
    const { admin } = makeAdmin(uploaderTables());
    const upload = vi.fn();
    vi.mocked(getDataRoomStorage).mockReturnValue({
      provider: 'local',
      upload,
      downloadStream: vi.fn(),
      remove: vi.fn(),
    } as never);
    signedIn(admin, 'md');

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'notes.md', { type: 'text/plain' }));
    form.set('room', 'internal');
    form.set('folder', 'source-materials');
    const res = await UPLOAD(
      new Request('http://localhost/api/v1/deals/d1/documents', { method: 'POST', body: form }),
      { params: Promise.resolve({ dealId: 'd1' }) },
    );
    expect(res.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('forwards folder and subpath to the RPC and does not offer a later move', async () => {
    const { admin } = makeAdmin(uploaderTables());
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: { id: 'doc-1', name: 'nda.docx', room: 'internal', folder: 'admin' },
        error: null,
      }),
    );
    vi.mocked(getDataRoomStorage).mockReturnValue({
      provider: 'local',
      upload: vi.fn(() =>
        Promise.resolve({ provider: 'local', fileId: 'f-1', sizeBytes: 3 }),
      ),
      downloadStream: vi.fn(),
      remove: vi.fn(),
    } as never);
    (admin as { rpc?: unknown }).rpc = rpc;
    signedIn(admin, 'md');

    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'nda.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    form.set('room', 'internal');
    form.set('folder', 'admin');
    form.set('folderSubpath', JSON.stringify(['NDA']));
    const res = await UPLOAD(
      new Request('http://localhost/api/v1/deals/d1/documents', { method: 'POST', body: form }),
      { params: Promise.resolve({ dealId: 'd1' }) },
    );
    expect(res.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith(
      'create_document_with_audit',
      expect.objectContaining({
        p_folder: 'admin',
        p_folder_subpath: ['NDA'],
      }),
    );
  });

  it('returns 201 without compensation when the RPC commits', async () => {
    const { admin } = makeAdmin(uploaderTables());
    const remove = vi.fn(() => Promise.resolve());
    vi.mocked(getDataRoomStorage).mockReturnValue({
      provider: 'local',
      upload: vi.fn(() =>
        Promise.resolve({ provider: 'local', fileId: 'f-1', sizeBytes: 3 }),
      ),
      downloadStream: vi.fn(),
      remove,
    } as never);
    (admin as { rpc?: unknown }).rpc = vi.fn(() =>
      Promise.resolve({ data: { id: 'doc-1', name: 'cim.pdf', room: 'deal' }, error: null }),
    );
    signedIn(admin, 'md');

    const res = await UPLOAD(uploadRequest(), { params: Promise.resolve({ dealId: 'd1' }) });
    expect(res.status).toBe(201);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('upload route — the data room input policy', () => {
  afterEach(() => vi.clearAllMocks());

  function upload(file: File, extra?: Record<string, string>) {
    const { admin } = makeAdmin(uploaderTables());
    const uploadFn = vi.fn(() =>
      Promise.resolve({ provider: 'local', fileId: 'f-1', sizeBytes: file.size }),
    );
    vi.mocked(getDataRoomStorage).mockReturnValue({
      provider: 'local',
      upload: uploadFn,
      downloadStream: vi.fn(),
      remove: vi.fn(),
    } as never);
    (admin as { rpc?: unknown }).rpc = vi.fn(() =>
      Promise.resolve({ data: { id: 'doc-1', name: file.name, room: 'deal' }, error: null }),
    );
    signedIn(admin, 'md');

    const form = new FormData();
    form.set('file', file);
    form.set('room', 'deal');
    form.set('classification', '2');
    for (const [key, value] of Object.entries(extra ?? {})) form.set(key, value);
    return {
      uploadFn,
      res: UPLOAD(
        new Request('http://localhost/api/v1/deals/d1/documents', { method: 'POST', body: form }),
        { params: Promise.resolve({ dealId: 'd1' }) },
      ),
    };
  }

  it('refuses an executable before storage runs', async () => {
    const { res, uploadFn } = upload(
      new File([new Uint8Array([1, 2, 3, 4])], 'evil.exe', { type: 'application/x-msdownload' }),
    );
    expect((await res).status).toBe(400);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('refuses an octet-stream blob with an unlisted extension', async () => {
    const { res } = upload(
      new File([new Uint8Array([1])], 'big.bin', { type: 'application/octet-stream' }),
    );
    expect((await res).status).toBe(400);
  });

  it('refuses a file over the size ceiling', async () => {
    const { res, uploadFn } = upload(
      new File([new Uint8Array(DOCUMENT_MAX_BYTES + 1)], 'huge.pdf', { type: 'application/pdf' }),
    );
    const response = await res;
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/capped at/i);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('refuses a display name that renames an allowed file to a blocked type', async () => {
    const { res } = upload(
      new File([new Uint8Array([1, 2, 3])], 'cim.pdf', { type: 'application/pdf' }),
      { name: 'payload.exe' },
    );
    expect((await res).status).toBe(400);
  });

  it('accepts a PDF inside the limits', async () => {
    const { res } = upload(
      new File([new Uint8Array([1, 2, 3])], 'cim.pdf', { type: 'application/pdf' }),
    );
    expect((await res).status).toBe(201);
  });
});

/* -------- list route: class-4 rows follow RLS documents_select (D1 = B, #78) -------- */

describe('list route — class-4 rows are dropped, not just disabled', () => {
  afterEach(() => vi.clearAllMocks());

  // One document per (room, class) cell, the same four the RLS parity probe
  // seeds (supabase/tests/rls_deal_scoped_policies.sql).
  const listedRows = [
    { id: 'i2', name: 'internal-class2.pdf', room: 'internal', classification: 2 },
    { id: 'i4', name: 'internal-class4.pdf', room: 'internal', classification: 4 },
    { id: 'd2', name: 'deal-class2.pdf', room: 'deal', classification: 2 },
    { id: 'd4', name: 'deal-class4.pdf', room: 'deal', classification: 4 },
  ].map((row) => ({
    ...row,
    min_phase: 0,
    uploaded_by: 'md',
    created_at: '2026-09-22T00:00:00Z',
    size_bytes: 10,
    content_type: 'application/pdf',
    storage_file_id: `f-${row.id}`,
    folder: null,
    folder_subpath: null,
  }));

  async function listAs(opts: {
    isExternal: boolean;
    firmRole: string | null;
    dealRole: string | null;
    flagOn?: boolean;
  }) {
    if (opts.flagOn === false) {
      // Both isFlagEnabled reads in GET (deal-ref resolution, list branch).
      vi.mocked(isFlagEnabled).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    }
    const { admin } = makeAdmin({
      // 1: requireApiUser status; 2: userCanAccessDeal profile; 3: getDocumentViewer profile.
      users: [
        activeStatus,
        { data: { firm_role: opts.firmRole, tenant_id: 't1' }, error: null },
        { data: { is_external: opts.isExternal, firm_role: opts.firmRole }, error: null },
      ],
      // resolveDealRef reads id/code, userCanAccessDeal reads tenant_id.
      deals: { data: { id: 'd1', code: 'PRJRA', tenant_id: 't1' }, error: null },
      // 1: userCanAccessDeal seat probe (members only); 2: getDocumentViewer seat.
      deal_memberships: opts.firmRole
        ? [{ data: opts.dealRole ? { deal_role: opts.dealRole, phase: 0 } : null, error: null }]
        : [
            { data: { id: 'm1' }, error: null },
            { data: { deal_role: opts.dealRole, phase: 0 }, error: null },
          ],
      documents: { data: listedRows.map((row) => ({ ...row })), error: null },
    });
    signedIn(admin, 'viewer');
    const res = await LIST(new Request('http://x/documents'), {
      params: Promise.resolve({ dealId: 'd1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: Array<{ id: string; canOpen: boolean }> };
    return body.documents;
  }

  const ids = (docs: Array<{ id: string }>) => docs.map((d) => d.id).sort();

  it('the deal MD sees all four rows, class 4 with Open enabled', async () => {
    const docs = await listAs({ isExternal: false, firmRole: null, dealRole: 'md' });
    expect(ids(docs)).toEqual(['d2', 'd4', 'i2', 'i4']);
    expect(docs.every((d) => d.canOpen)).toBe(true);
  });

  it('a same-tenant overseer with no seat sees all four rows', async () => {
    const docs = await listAs({ isExternal: false, firmRole: 'cco', dealRole: null });
    expect(ids(docs)).toEqual(['d2', 'd4', 'i2', 'i4']);
    expect(docs.every((d) => d.canOpen)).toBe(true);
  });

  it.each(['deal_team', 'legal', 'read_only'])(
    'a %s member sees the class-2 rows of both rooms and no class-4 row',
    async (dealRole) => {
      const docs = await listAs({ isExternal: false, firmRole: null, dealRole });
      expect(ids(docs)).toEqual(['d2', 'i2']);
    },
  );

  it('an external seller sees only the deal-room class-2 row', async () => {
    const docs = await listAs({ isExternal: true, firmRole: null, dealRole: 'seller' });
    expect(ids(docs)).toEqual(['d2']);
  });

  describe('with platform_onboarding off (#229)', () => {
    it('the deal MD and a same-tenant overseer still see all four rows', async () => {
      const mdDocs = await listAs({ isExternal: false, firmRole: null, dealRole: 'md', flagOn: false });
      expect(ids(mdDocs)).toEqual(['d2', 'd4', 'i2', 'i4']);
      const ccoDocs = await listAs({ isExternal: false, firmRole: 'cco', dealRole: null, flagOn: false });
      expect(ids(ccoDocs)).toEqual(['d2', 'd4', 'i2', 'i4']);
    });

    it.each(['deal_team', 'read_only'])('a %s member gets no class-4 row', async (dealRole) => {
      const docs = await listAs({ isExternal: false, firmRole: null, dealRole, flagOn: false });
      expect(ids(docs)).toEqual(['d2', 'i2']);
    });

    it('an external seller gets no internal-room row, and the legacy shape gains no room', async () => {
      const docs = await listAs({ isExternal: true, firmRole: null, dealRole: 'seller', flagOn: false });
      expect(ids(docs)).toEqual(['d2']);
      expect(docs[0]).not.toHaveProperty('room');
      expect(docs[0]).not.toHaveProperty('canOpen');
    });
  });
});
