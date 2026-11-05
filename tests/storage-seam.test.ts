import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStorage } from '@/lib/storage/local';
import { resolveStorageProvider, resetDataRoomStorage } from '@/lib/storage';
import { DOCUMENT_ROOM } from '@/lib/constants/documents';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: vi.fn(),
}));

import { createSupabaseAdminClient } from '@/lib/supabase/server';

function mockStorageBucket() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  // jsdom's Blob has no .stream(); hand back a Blob-shaped object instead.
  const download = vi.fn().mockResolvedValue({
    data: {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
    },
    error: null,
  });
  const remove = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(createSupabaseAdminClient).mockReturnValue({
    storage: { from: vi.fn().mockReturnValue({ upload, download, remove }) },
  } as unknown as ReturnType<typeof createSupabaseAdminClient>);
  return { upload, download, remove };
}

afterEach(() => {
  vi.clearAllMocks();
  resetDataRoomStorage();
});

describe('resolveStorageProvider', () => {
  it('defaults to local so dev/CI never needs Box credentials', () => {
    expect(resolveStorageProvider({} as unknown as NodeJS.ProcessEnv)).toBe('local');
    expect(resolveStorageProvider({ STORAGE_PROVIDER: 'nonsense' } as unknown as NodeJS.ProcessEnv)).toBe(
      'local',
    );
  });

  it('selects box only when explicitly configured', () => {
    expect(resolveStorageProvider({ STORAGE_PROVIDER: 'box' } as unknown as NodeJS.ProcessEnv)).toBe('box');
    expect(resolveStorageProvider({ STORAGE_PROVIDER: 'BOX' } as unknown as NodeJS.ProcessEnv)).toBe('box');
  });
});

describe('LocalStorage room separation', () => {
  it('shapes paths as {dealCode}/{room}/{uuid}-{name}', () => {
    const local = new LocalStorage();
    const path = local.buildPath('PR-ATLS-001', DOCUMENT_ROOM.INTERNAL, 'model v2.xlsx');
    expect(path).toMatch(
      /^PR-ATLS-001\/internal\/[0-9a-f-]{36}-model_v2\.xlsx$/,
    );
  });

  it('never routes internal-room bytes into the deal-room prefix', async () => {
    const { upload } = mockStorageBucket();
    const local = new LocalStorage();

    const internal = await local.upload(
      'PR-ATLS-001',
      DOCUMENT_ROOM.INTERNAL,
      'valuation.pdf',
      'application/pdf',
      new Uint8Array([1]),
    );
    const deal = await local.upload(
      'PR-ATLS-001',
      DOCUMENT_ROOM.DEAL,
      'cim.pdf',
      'application/pdf',
      new Uint8Array([1, 2]),
    );

    expect(internal.fileId.startsWith('PR-ATLS-001/internal/')).toBe(true);
    expect(internal.fileId.includes('/deal/')).toBe(false);
    expect(deal.fileId.startsWith('PR-ATLS-001/deal/')).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(internal.provider).toBe('local');
    expect(deal.sizeBytes).toBe(2);
  });

  it('streams downloads and deletes by fileId', async () => {
    const { download, remove } = mockStorageBucket();
    const local = new LocalStorage();

    const stream = await local.downloadStream('PR-ATLS-001/deal/abc-cim.pdf');
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(download).toHaveBeenCalledWith('PR-ATLS-001/deal/abc-cim.pdf');

    await local.remove('PR-ATLS-001/deal/abc-cim.pdf');
    expect(remove).toHaveBeenCalledWith(['PR-ATLS-001/deal/abc-cim.pdf']);
  });
});
