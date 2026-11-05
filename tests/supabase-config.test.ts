import { afterEach, describe, expect, it } from 'vitest';
import {
  SUPABASE_ENV_KEYS,
  getMissingSupabaseEnvVars,
  getSupabaseConfig,
  isSupabaseConfigured,
} from '@/lib/supabase/config';
import {
  SUPABASE_TEST_PROJECT,
  clearSupabaseEnv,
  setSupabaseEnv,
} from './helpers/supabase-env';

describe('supabase config', () => {
  afterEach(() => {
    clearSupabaseEnv();
  });

  it('reports missing public Supabase env vars', () => {
    expect(getMissingSupabaseEnvVars()).toEqual([
      SUPABASE_ENV_KEYS.url,
      SUPABASE_ENV_KEYS.publishableKey,
    ]);
    expect(isSupabaseConfigured()).toBe(false);
    expect(getSupabaseConfig()).toBeNull();
  });

  it('returns config when public env vars are set', () => {
    setSupabaseEnv({
      url: SUPABASE_TEST_PROJECT.url,
      publishableKey: SUPABASE_TEST_PROJECT.publishableKey,
      secretKey: SUPABASE_TEST_PROJECT.secretKey,
      environment: 'staging',
    });

    expect(getMissingSupabaseEnvVars()).toEqual([]);
    expect(isSupabaseConfigured()).toBe(true);
    expect(getSupabaseConfig()).toEqual({
      url: SUPABASE_TEST_PROJECT.url,
      publishableKey: SUPABASE_TEST_PROJECT.publishableKey,
      secretKey: SUPABASE_TEST_PROJECT.secretKey,
      environment: 'staging',
    });
  });

  it('defaults environment to dev when unset', () => {
    setSupabaseEnv({
      url: SUPABASE_TEST_PROJECT.url,
      publishableKey: SUPABASE_TEST_PROJECT.publishableKey,
    });

    expect(getSupabaseConfig()?.environment).toBe('dev');
  });
});
