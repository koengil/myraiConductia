// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { POST as UPLOAD } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/upload/route';
import { requireApiUser } from '@/lib/api/v1/http';
import { orderedSteps } from '@/lib/rail/dealRail';

/**
 * #249: the Box upload is not transactional with the document and audit rows,
 * so a failure after the upload must delete the Box file instead of leaving a
 * bank document in Box with no record.
 */

const box = {
  uploadFile: vi.fn(() => Promise.resolve({ id: 'box-1', name: 'cim.pdf', size: 3, createdAt: '', url: '' })),
  deleteFile: vi.fn(() => Promise.resolve()),
};

vi.mock('@/lib/box', () => ({ getBoxClient: () => box }));
vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: vi.fn(() => Promise.resolve({ id: 'd1', code: 'PRJRA' })),
  provisionDataroomFolder: vi.fn(() =>
    Promise.resolve({ id: 'room-1', box_folder_id: 'folder-1', min_phase: 1 }),
  ),
}));
vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: vi.fn(() => Promise.resolve(true)),
  classifyInternalUser: vi.fn(() => Promise.resolve('internal')),
  userCanUploadToDataroom: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/http', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: vi.fn(),
}));

type Resp = { data: unknown; error: { message: string } | null };

function makeAdmin(tables: Record<string, Resp>) {
  const deletes: string[] = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      let resp = tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) builder[m] = () => builder;
      builder.insert = (payload: Record<string, unknown>) => {
        inserts.push({ table, payload });
        return builder;
      };
      builder.delete = () => {
        deletes.push(table);
        resp = tables[`${table}:delete`] ?? { data: null, error: null };
        return builder;
      };
      builder.single = () => Promise.resolve(resp);
      builder.then = (res: (v: Resp) => unknown) => Promise.resolve(resp).then(res);
      return builder;
    },
  };
  return { admin: admin as unknown as SupabaseClient, deletes, inserts };
}

function post(fileName = 'cim.pdf') {
  const form = new FormData();
  form.append('file', new File(['pdf'], fileName));
  return UPLOAD(new Request('http://localhost/x', { method: 'POST', body: form }), {
    params: Promise.resolve({ dealId: 'd1', stepId: orderedSteps()[0].id }),
  });
}

function signIn(admin: SupabaseClient) {
  vi.mocked(requireApiUser).mockResolvedValue({ ok: true, admin, user: { id: 'u1' } } as never);
}

const docRow: Resp = { data: { id: 'doc-1', name: 'cim.pdf' }, error: null };

describe('dataroom upload cleans up Box on failure (#249)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the Box file when the document row is rejected', async () => {
    const { admin } = makeAdmin({ documents: { data: null, error: { message: 'boom' } } });
    signIn(admin);
    const res = await post();
    expect(res.status).toBe(500);
    expect(box.deleteFile).toHaveBeenCalledWith('box-1');
  });

  it('deletes the row and the Box file when the audit row is rejected', async () => {
    const { admin, deletes } = makeAdmin({
      documents: docRow,
      audit_log: { data: null, error: { message: 'chain' } },
    });
    signIn(admin);
    const res = await post();
    expect(res.status).toBe(500);
    expect(deletes).toEqual(['documents']);
    expect(box.deleteFile).toHaveBeenCalledWith('box-1');
  });

  it('keeps the Box file when the row cannot be rolled back (legal hold)', async () => {
    const { admin, deletes } = makeAdmin({
      documents: docRow,
      'documents:delete': { data: null, error: { message: 'legal_hold' } },
      audit_log: { data: null, error: { message: 'chain' } },
    });
    signIn(admin);
    const res = await post();
    expect(res.status).toBe(500);
    expect(deletes).toEqual(['documents']);
    expect(box.deleteFile).not.toHaveBeenCalled();
  });

  it('keeps the Box file on success', async () => {
    const { admin } = makeAdmin({ documents: docRow });
    signIn(admin);
    const res = await post();
    expect(res.status).toBe(201);
    expect(box.deleteFile).not.toHaveBeenCalled();
  });
});

describe('dataroom upload sends Box a safe name (#328)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sanitizes the Box name and keeps the original name on the documents row', async () => {
    const { admin, inserts } = makeAdmin({ documents: docRow });
    signIn(admin);
    const res = await post('Q3\\cim.pdf.');
    expect(res.status).toBe(201);
    expect(box.uploadFile).toHaveBeenCalledWith(
      'folder-1',
      expect.stringMatching(/^[0-9a-f]{8}-Q3-cim\.pdf$/),
      expect.anything(),
    );
    const document = inserts.find((entry) => entry.table === 'documents');
    expect(document?.payload.name).toBe('Q3\\cim.pdf.');
  });

  it('sends Box a distinct name for each upload of the same file', async () => {
    const { admin, inserts } = makeAdmin({ documents: docRow });
    signIn(admin);
    expect((await post('cim.pdf')).status).toBe(201);
    expect((await post('cim.pdf')).status).toBe(201);

    const boxNames = box.uploadFile.mock.calls.map((call) => (call as unknown[])[1] as string);
    expect(boxNames).toHaveLength(2);
    for (const name of boxNames) expect(name).toMatch(/^[0-9a-f]{8}-cim\.pdf$/);
    expect(boxNames[0]).not.toBe(boxNames[1]);
    const names = inserts
      .filter((entry) => entry.table === 'documents')
      .map((entry) => entry.payload.name);
    expect(names).toEqual(['cim.pdf', 'cim.pdf']);
  });

  it('keeps the extension of an over-long name within 255 characters', async () => {
    const { admin } = makeAdmin({ documents: docRow });
    signIn(admin);
    expect((await post(`${'a'.repeat(300)}.pdf`)).status).toBe(201);

    const name = (box.uploadFile.mock.calls[0] as unknown[])[1] as string;
    expect(name.length).toBe(255);
    expect(name).toMatch(/^[0-9a-f]{8}-a+\.pdf$/);
  });
});
