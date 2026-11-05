import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoxStorage } from '@/lib/storage/box';

describe('BoxStorage.ensureDealFolders', () => {
  beforeEach(() => {
    vi.stubEnv('BOX_DEV_TOKEN', 'test-dev-token');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as {
          name: string;
          parent: { id: string };
        };
        return new Response(
          JSON.stringify({ id: `folder-${body.parent.id}-${body.name}` }),
          { status: 201 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('creates the environment-partitioned Conductia deal tree for both rooms', async () => {
    const box = new BoxStorage();
    await box.ensureDealFolders('ATLAS-2026-001');

    expect(fetch).toHaveBeenCalledTimes(5);
    const bodies = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => JSON.parse(init?.body as string) as { name: string; parent: { id: string } });
    expect(bodies).toEqual([
      { name: 'develop', parent: { id: '0' } },
      { name: 'Conductia', parent: { id: 'folder-0-develop' } },
      { name: 'ATLAS-2026-001', parent: { id: 'folder-folder-0-develop-Conductia' } },
      { name: 'internal', parent: { id: 'folder-folder-folder-0-develop-Conductia-ATLAS-2026-001' } },
      { name: 'dealroom', parent: { id: 'folder-folder-folder-0-develop-Conductia-ATLAS-2026-001' } },
    ]);
  });

  it('sends Box a safe folder name when a segment carries a slash (#328)', async () => {
    const box = new BoxStorage();
    await box.ensureDealFolders('ATLAS/2026\\001.');

    const names = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => (JSON.parse(init?.body as string) as { name: string }).name);
    expect(names).toEqual(['develop', 'Conductia', 'ATLAS-2026-001', 'internal', 'dealroom']);
    for (const name of names) expect(name).not.toMatch(/[/\\]/);
  });
});

describe('BoxStorage.upload names the stored file (#328)', () => {
  const uploads: Array<{ attributes: { name: string; parent: { id: string } }; fileName: string }> =
    [];

  beforeEach(() => {
    uploads.length = 0;
    vi.stubEnv('BOX_DEV_TOKEN', 'test-dev-token');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
        if (init?.body instanceof FormData) {
          const file = init.body.get('file') as File;
          uploads.push({
            attributes: JSON.parse(init.body.get('attributes') as string) as {
              name: string;
              parent: { id: string };
            },
            fileName: file.name,
          });
          return new Response(JSON.stringify({ entries: [{ id: 'file-1', size: 3 }] }), {
            status: 201,
          });
        }
        const body = JSON.parse(init?.body as string) as { name: string };
        return new Response(JSON.stringify({ id: `folder-${body.name}` }), { status: 201 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends a name with no slash, within 255 characters, extension kept', async () => {
    const box = new BoxStorage();
    await box.upload(
      'ATLAS-2026-001',
      'internal',
      `Q3/board\\${'p'.repeat(300)}.pdf`,
      'application/pdf',
      new Uint8Array([1, 2, 3]),
    );

    expect(uploads).toHaveLength(1);
    const { attributes, fileName } = uploads[0];
    expect(attributes.name).not.toMatch(/[/\\]/);
    expect(attributes.name.length).toBeLessThanOrEqual(255);
    expect(attributes.name).toMatch(/^[0-9a-f]{8}-Q3-board-p+\.pdf$/);
    expect(attributes.parent.id).toBe('folder-internal');
    expect(fileName).toBe(attributes.name);
  });
});
