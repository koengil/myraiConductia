import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBoxClient } from '@/lib/box';
import { createBoxClient } from '@/lib/box/client';
import { createMockBoxClient } from '@/lib/box/mock';
import { DATAROOM_STEP_DEFS } from '@/lib/constants/dataroomSteps';
import { UpstreamHttpError } from '@/lib/errors/upstream';

describe('getBoxClient (mock mode)', () => {
  it('reuses one in-memory store across calls', async () => {
    const box1 = getBoxClient();
    const folder = await box1.createFolder('deal-step', '0');
    await box1.uploadFile(folder.id, 'test.pdf', Buffer.from('bytes'));
    const box2 = getBoxClient();
    const files = await box2.listFolderItems(folder.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('test.pdf');
  });
});

describe('createMockBoxClient', () => {
  it('creates folders and lists uploaded files', async () => {
    const box = createMockBoxClient();
    const folder = await box.createFolder('ATLAS-2026-001 — Data room index', '0');
    expect(folder.id).toMatch(/^mock-box-/);
    expect(folder.url).toContain(folder.id);

    await box.uploadFile(folder.id, 'engagement-letter.pdf', Buffer.from('pdf-bytes'));
    const files = await box.listFolderItems(folder.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('engagement-letter.pdf');
    expect(files[0].size).toBe(Buffer.from('pdf-bytes').length);
  });

  it('replaces a file with the same name on re-upload', async () => {
    const box = createMockBoxClient();
    const folder = await box.createFolder('deal-step', 'parent');
    await box.uploadFile(folder.id, 'cim.pdf', Buffer.from('v1'));
    await box.uploadFile(folder.id, 'cim.pdf', Buffer.from('v2-longer'));
    const files = await box.listFolderItems(folder.id);
    expect(files).toHaveLength(1);
    expect(files[0].size).toBe(Buffer.from('v2-longer').length);
  });
});

describe('DATAROOM_STEP_DEFS', () => {
  it('includes MD Briefing with upload required', () => {
    const briefing = DATAROOM_STEP_DEFS.find((s) => s.stepId === 'p1-s9');
    expect(briefing?.requiresUpload).toBe(true);
  });

  it('includes the VDR setup step with upload required', () => {
    const vdr = DATAROOM_STEP_DEFS.find((s) => s.stepId === 'p2-s31');
    expect(vdr?.requiresUpload).toBe(true);
  });

  it('maps to canonical rail step ids', () => {
    expect(DATAROOM_STEP_DEFS.map((s) => s.stepId)).toContain('p2-s32');
  });
});

describe('createBoxClient createFolder (#331)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns a 409 with a plain-text body into an UpstreamHttpError that never quotes the folder name', async () => {
    const FOLDER = 'Project Falcon Board Pack';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/oauth2/token')
          ? new Response(JSON.stringify({ access_token: 'token-1', expires_in: 3600 }), { status: 200 })
          : new Response(`Conflict: a folder named ${FOLDER} already exists`, {
              status: 409,
              headers: { 'content-type': 'text/plain', 'box-request-id': 'req-409' },
            }),
      ),
    );
    const box = createBoxClient({ clientId: 'id', clientSecret: 'secret', enterpriseId: 'ent' });

    const error = await box.createFolder(FOLDER, '0').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect(error).toMatchObject({ provider: 'box', op: 'createFolder', status: 409, code: null });
    for (const text of [(error as Error).message, JSON.stringify({ ...(error as object) }), String(error)]) {
      expect(text).not.toContain('Falcon');
    }
  });
});
