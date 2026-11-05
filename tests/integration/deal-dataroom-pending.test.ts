import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

const box = vi.hoisted(() => ({ failing: true }));

vi.mock('@/lib/box', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/box')>();
  return {
    ...actual,
    getBoxClient: () => {
      const real = actual.getBoxClient();
      return {
        ...real,
        createFolder: async (name: string, parentFolderId: string) => {
          if (box.failing) throw Object.assign(new Error('Box createFolder 400'), { code: 'item_name_invalid' });
          return real.createFolder(name, parentFolderId);
        },
      };
    },
  };
});

import { DATAROOM_STEP_DEFS } from '@/lib/constants/dataroomSteps';
import { dealDataroomStatus, provisionDealDataroomOnCreate } from '@/lib/dataroom/steps';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const TENANT = randomUUID();
const bankId = randomUUID();
const dealId = randomUUID();
const code = `PL27-${dealId.slice(0, 8).toUpperCase()}`;

async function pendingSince(): Promise<string | null> {
  const { data, error } = await db.from('deals').select('dataroom_pending_since').eq('id', dealId).single();
  if (error) throw error;
  return (data as { dataroom_pending_since: string | null }).dataroom_pending_since;
}

beforeAll(async () => {
  const company = await db.from('companies').insert({ id: bankId, tenant_id: TENANT, name: `PL27 Bank ${bankId}`, type: 'bank' });
  if (company.error) throw company.error;
  const deal = await db.from('deals').insert({ id: dealId, tenant_id: TENANT, code, codename: `PL27 deal ${code}`, bank_id: bankId });
  if (deal.error) throw deal.error;
});

afterAll(async () => {
  await db.from('datarooms').delete().eq('deal_id', dealId);
  await db.from('deals').delete().eq('id', dealId);
  await db.from('companies').delete().eq('id', bankId);
});

describe('deal data room pending state against Postgres (PL-27)', () => {
  it('records a failed setup on the deal, keeps the first stamp, and clears it once a retry completes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await provisionDealDataroomOnCreate(db, dealId, code)).toBe('pending');
    const firstStamp = await pendingSince();
    expect(firstStamp).not.toBeNull();
    expect(await dealDataroomStatus(db, dealId)).toBe('pending');

    expect(await provisionDealDataroomOnCreate(db, dealId, code)).toBe('pending');
    expect(await pendingSince()).toBe(firstStamp);

    box.failing = false;
    expect(await provisionDealDataroomOnCreate(db, dealId, code)).toBe('ready');
    expect(await pendingSince()).toBeNull();
    expect(await dealDataroomStatus(db, dealId)).toBe('ready');

    const { data: rooms, error } = await db
      .from('datarooms')
      .select('step_id, box_folder_id')
      .eq('deal_id', dealId);
    if (error) throw error;
    expect((rooms ?? []).map((room) => room.step_id).sort()).toEqual(
      DATAROOM_STEP_DEFS.map((def) => def.stepId).sort(),
    );
    for (const room of rooms ?? []) expect(room.box_folder_id).toBeTruthy();
  });
});
