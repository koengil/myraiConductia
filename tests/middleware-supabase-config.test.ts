import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase/config', () => ({
  getSupabaseConfig: () => null,
}));

import { middleware } from '@/middleware';

afterEach(() => vi.unstubAllEnvs());

describe('middleware without Supabase configuration', () => {
  it('fails closed in production', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.status).toBe(503);
  });

  it('fails closed in staging', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'staging');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.status).toBe(503);
  });

  it('remains a no-op in local development', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    const response = await middleware(new NextRequest('https://app.test/projects/rangers'));
    expect(response.status).toBe(200);
  });
});
