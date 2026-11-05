import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { requireFlag } from '@/lib/flags/requireFlag';
import { POST as outboxPost } from '@/app/api/v1/outbox/route';

/*
 * requireFlag — the server-side kill switch for flagged API surfaces
 * (ADR-0007 fail-closed): 404 unless the flag row is explicitly enabled.
 * The mail channel can send real external email, so every mail route gates
 * on 'mail_channel'.
 */

function flagAdmin(row: { enabled: boolean } | null, fail = false) {
  const builder: Record<string, unknown> = {};
  for (const k of ['select', 'eq']) builder[k] = () => builder;
  builder.maybeSingle = () =>
    fail ? Promise.reject(new Error('db down')) : Promise.resolve({ data: row, error: null });
  return { from: () => builder } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

afterEach(() => vi.clearAllMocks());

describe('requireFlag', () => {
  it('null (proceed) when the flag row is enabled', async () => {
    vi.mocked(createSupabaseAdminClient).mockReturnValue(flagAdmin({ enabled: true }));
    expect(await requireFlag('mail_channel')).toBeNull();
  });

  it('404 when the flag is disabled', async () => {
    vi.mocked(createSupabaseAdminClient).mockReturnValue(flagAdmin({ enabled: false }));
    expect((await requireFlag('mail_channel'))?.status).toBe(404);
  });

  it('404 when the flag row is missing (fail-closed)', async () => {
    vi.mocked(createSupabaseAdminClient).mockReturnValue(flagAdmin(null));
    expect((await requireFlag('mail_channel'))?.status).toBe(404);
  });

  it('404 when the flag source errors (fail-closed)', async () => {
    vi.mocked(createSupabaseAdminClient).mockReturnValue(flagAdmin(null, true));
    expect((await requireFlag('mail_channel'))?.status).toBe(404);
  });

  it('a mail route 404s before auth when the channel is off', async () => {
    vi.mocked(createSupabaseAdminClient).mockReturnValue(flagAdmin(null));
    const res = await outboxPost(
      new Request('http://localhost/api/v1/outbox', {
        method: 'POST',
        body: JSON.stringify({ to: ['a@b.co'], subject: 's', body: 'b' }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
