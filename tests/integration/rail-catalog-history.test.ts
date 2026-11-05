import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createProvisionedUser } from '@/lib/auth/provisioning';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY ' +
      '(local `supabase start` stack or the -dev project).',
  );
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = randomUUID();
const DIRECTOR_NAME = `History Director ${RUN}`;

const session = { userId: '', email: '' };

vi.mock('@/lib/api/v1/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/http')>();
  return {
    ...actual,
    requireApiUser: async () => ({
      ok: true as const,
      user: { id: session.userId, email: session.email },
      admin,
    }),
  };
});

import { POST as createTemplate } from '@/app/api/v1/rail-catalog/route';
import { GET as readTemplate } from '@/app/api/v1/rail-catalog/[templateId]/route';
import { GET as readHistory } from '@/app/api/v1/rail-catalog/[templateId]/changes/route';
import { DELETE as removeStep } from '@/app/api/v1/rail-catalog/[templateId]/steps/[stepRowId]/route';

let bankId = '';
let templateId = '';

async function seedDirector(): Promise<void> {
  const { data: bank, error: bankError } = await admin
    .from('companies')
    .insert({ tenant_id: TENANT, name: `History Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (bankError || !bank) throw new Error(`bank seed failed: ${bankError?.message}`);
  bankId = bank.id;

  session.email = `${randomUUID()}-${RUN}@integration.conductia.dev`;
  const { id } = await createProvisionedUser(admin, {
    email: session.email,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  session.userId = id;

  const { error: userError } = await admin
    .from('users')
    .update({
      tenant_id: TENANT,
      status: 'active',
      company_id: bankId,
      company_role: 'director',
      display_name: DIRECTOR_NAME,
    })
    .eq('id', id);
  if (userError) throw new Error(`director seed failed: ${userError.message}`);
}

afterAll(async () => {
  if (templateId) {
    await admin.from('rail_catalog_changes').delete().eq('template_id', templateId);
    await admin.from('rail_catalog_steps').delete().eq('template_id', templateId);
    await admin.from('rail_catalog_templates').delete().eq('id', templateId);
  }
  if (session.userId) await admin.from('users').delete().eq('id', session.userId);
  if (bankId) await admin.from('companies').delete().eq('id', bankId);
});

describe('rail catalog history', () => {
  it('lists a change with the name of the person who made it and the title of the step', async () => {
    await seedDirector();

    const created = await createTemplate(
      new Request('http://localhost/api/v1/rail-catalog', {
        method: 'POST',
        body: JSON.stringify({ name: `History Rail ${RUN}` }),
      }),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    templateId = ((await created.json()) as { template: { id: string } }).template.id;

    const detail = await readTemplate(new Request('http://localhost'), {
      params: Promise.resolve({ templateId }),
    });
    expect(detail.status, await detail.clone().text()).toBe(200);
    const steps = ((await detail.json()) as { steps: { id: string; title: string }[] }).steps;
    const removed = steps[steps.length - 1];

    const removal = await removeStep(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ templateId, stepRowId: removed.id }),
    });
    expect(removal.status, await removal.clone().text()).toBe(200);

    const history = await readHistory(new Request('http://localhost'), {
      params: Promise.resolve({ templateId }),
    });

    expect(history.status, await history.clone().text()).toBe(200);
    const { changes } = (await history.json()) as {
      changes: { action: string; summary: string; actorName: string; canUndo: boolean }[];
    };
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      action: 'remove_step',
      summary: `Removed "${removed.title}"`,
      actorName: DIRECTOR_NAME,
      canUndo: true,
    });
  });
});
