import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const boxState = vi.hoisted(() => ({
  createdFolders: [] as Array<{ name: string; parentId: string }>,
  uploads: [] as Array<{ folderId: string; fileName: string }>,
}));

vi.mock('@/lib/box', async () => {
  const actual = await vi.importActual<typeof import('@/lib/box')>('@/lib/box');
  return {
    ...actual,
    getBoxClient: () => ({
      createFolder: async (name: string, parentId: string) => {
        boxState.createdFolders.push({ name, parentId });
        return { id: `folder-${String(boxState.createdFolders.length)}`, url: `https://box.test/${name}` };
      },
      uploadFile: async (folderId: string, fileName: string) => {
        boxState.uploads.push({ folderId, fileName });
        return { id: 'box-file-1' };
      },
    }),
  };
});

import { BOX_NAME_MAX_LENGTH } from '@/lib/box';
import { DATAROOM_STEP_DEFS } from '@/lib/constants/dataroomSteps';
import { fileBytesToStepDataroom } from '@/lib/dataroom/fileToStep';
import { provisionDataroomFolder } from '@/lib/dataroom/steps';
import { MD_BRIEFING_STEP_ID } from '@/lib/ignatious/config';
import {
  mdBriefingScopes,
  mintTriggerToken,
  readTriggerClaims,
  skillStepRunScopes,
} from '@/lib/ignatious/jwt';
import { orderedSteps } from '@/lib/rail/dealRail';

const DEAL_ID = 'deal-1';
const DEAL_CODE = 'ATLAS-2026-001';
const TENANT_ID = '00000000-0000-4000-8000-00000000000a';
const CUSTOM_STEP_ID = 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const CUSTOM_STEP_TITLE = 'Weekly project update';
const RUN_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const AGENT_RUN_ID = 'run_4b95e9584fc30266';
const SEPARATOR = '\u2014';
// The first eight hex digits of CUSTOM_STEP_ID's uuid tag its folder (#328).
const CUSTOM_STEP_TAG = '0f1e2d3c';

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp[]>) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const queue = tables[table] ?? [];
    const next = (): Resp => queue.shift() ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit', 'delete']) {
      builder[method] = () => builder;
    }
    builder.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      return builder;
    };
    builder.update = (payload: Record<string, unknown>) => {
      updates.push({ table, payload });
      return builder;
    };
    builder.single = () => Promise.resolve(next());
    builder.maybeSingle = () => Promise.resolve(next());
    builder.then = (resolve: (value: Resp) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { admin: { from } as unknown as SupabaseClient, inserts, updates };
}

function dataroomRow(stepId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'dr-1',
    deal_id: DEAL_ID,
    step_id: stepId,
    provider: 'box',
    box_folder_id: null,
    box_folder_url: null,
    requires_upload: false,
    min_phase: 0,
    ...overrides,
  };
}

function provisionedRow(stepId: string) {
  return dataroomRow(stepId, { box_folder_id: 'folder-2', box_folder_url: 'https://box.test/step' });
}

function lastFolderName(): string | undefined {
  return boxState.createdFolders.at(-1)?.name;
}

beforeEach(() => {
  boxState.createdFolders = [];
  boxState.uploads = [];
});

describe('trigger claims carry the step a run files against', () => {
  it('round-trips the step id and title', () => {
    const token = mintTriggerToken({
      agentName: 'skill-step-run',
      dealId: DEAL_ID,
      conductiaTenantId: TENANT_ID,
      scopes: skillStepRunScopes(),
      stepId: CUSTOM_STEP_ID,
      stepTitle: CUSTOM_STEP_TITLE,
    });

    const claims = readTriggerClaims(`Bearer ${token}`);

    expect(claims?.stepId).toBe(CUSTOM_STEP_ID);
    expect(claims?.stepTitle).toBe(CUSTOM_STEP_TITLE);
  });

  it('leaves a token minted without a step carrying neither field', () => {
    const token = mintTriggerToken({
      agentName: 'md-briefing',
      dealId: DEAL_ID,
      conductiaTenantId: TENANT_ID,
      scopes: mdBriefingScopes(),
    });

    const claims = readTriggerClaims(`Bearer ${token}`);

    expect(claims).not.toBeNull();
    expect(claims && 'stepId' in claims).toBe(false);
    expect(claims && 'stepTitle' in claims).toBe(false);
  });
});

describe('provisionDataroomFolder names the Box folder', () => {
  it('uses a supplied title for a step the census does not know', async () => {
    const { admin, inserts } = makeAdmin({
      datarooms: [
        { data: null, error: null },
        { data: dataroomRow(CUSTOM_STEP_ID), error: null },
        { data: provisionedRow(CUSTOM_STEP_ID), error: null },
      ],
    });

    const row = await provisionDataroomFolder(
      admin,
      DEAL_ID,
      CUSTOM_STEP_ID,
      DEAL_CODE,
      CUSTOM_STEP_TITLE,
    );

    expect(lastFolderName()).toBe(
      `${DEAL_CODE} ${SEPARATOR} ${CUSTOM_STEP_TITLE} (${CUSTOM_STEP_TAG})`,
    );
    expect(row.box_folder_id).toBe('folder-2');
    expect(inserts[0]?.payload.requires_upload).toBe(false);
  });

  it('refuses a step the census does not know when no title is supplied', async () => {
    const { admin } = makeAdmin({ datarooms: [{ data: null, error: null }] });

    await expect(
      provisionDataroomFolder(admin, DEAL_ID, CUSTOM_STEP_ID, DEAL_CODE),
    ).rejects.toThrow(/Unknown rail step/);
  });

  it('still resolves a census step from four arguments', async () => {
    const censusTitle = orderedSteps().find((step) => step.id === MD_BRIEFING_STEP_ID)?.title;
    expect(censusTitle).toBe('MD Briefing + Company Backgrounding');

    const { admin } = makeAdmin({
      datarooms: [
        { data: dataroomRow(MD_BRIEFING_STEP_ID), error: null },
        { data: provisionedRow(MD_BRIEFING_STEP_ID), error: null },
      ],
    });

    await provisionDataroomFolder(admin, DEAL_ID, MD_BRIEFING_STEP_ID, DEAL_CODE);

    expect(lastFolderName()).toBe(
      `${DEAL_CODE} ${SEPARATOR} ${censusTitle ?? ''} (${MD_BRIEFING_STEP_ID})`,
    );
  });

  it('gives p2-s32, whose census title carries a slash, a name Box accepts (#328)', async () => {
    const censusTitle = orderedSteps().find((step) => step.id === 'p2-s32')?.title;
    expect(censusTitle).toBe('Document Intake / Metadata');

    const { admin } = makeAdmin({
      datarooms: [
        { data: dataroomRow('p2-s32'), error: null },
        { data: provisionedRow('p2-s32'), error: null },
      ],
    });

    const row = await provisionDataroomFolder(admin, DEAL_ID, 'p2-s32', DEAL_CODE);

    expect(row.box_folder_id).toBe('folder-2');
    for (const { name } of boxState.createdFolders) {
      expect(name).not.toMatch(/[/\\]/);
    }
    expect(lastFolderName()).toBe(`${DEAL_CODE} ${SEPARATOR} Document Intake - Metadata (p2-s32)`);
  });

  it('passes no slash to createFolder for a supplied title that carries one (#328)', async () => {
    const { admin } = makeAdmin({
      datarooms: [
        { data: null, error: null },
        { data: dataroomRow(CUSTOM_STEP_ID), error: null },
        { data: provisionedRow(CUSTOM_STEP_ID), error: null },
      ],
    });

    await provisionDataroomFolder(
      admin,
      DEAL_ID,
      CUSTOM_STEP_ID,
      DEAL_CODE,
      'Buyers / Sellers \\ Q&A.',
    );

    for (const { name } of boxState.createdFolders) {
      expect(name).not.toMatch(/[/\\]/);
    }
    expect(lastFolderName()).toBe(
      `${DEAL_CODE} ${SEPARATOR} Buyers - Sellers - Q&A (${CUSTOM_STEP_TAG})`,
    );
  });
});

describe('provisionDataroomFolder keeps steps apart in Box (#328)', () => {
  const OTHER_STEP_ID = 'custom:9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  async function provisionCustom(stepId: string, title: string) {
    const { admin } = makeAdmin({
      datarooms: [
        { data: null, error: null },
        { data: dataroomRow(stepId), error: null },
        { data: provisionedRow(stepId), error: null },
      ],
    });
    await provisionDataroomFolder(admin, DEAL_ID, stepId, DEAL_CODE, title);
    return lastFolderName();
  }

  it('gives two steps whose titles sanitize alike two folders', async () => {
    const first = await provisionCustom(CUSTOM_STEP_ID, 'A / B');
    const second = await provisionCustom(OTHER_STEP_ID, 'A - B');

    expect(first).toBe(`${DEAL_CODE} ${SEPARATOR} A - B (${CUSTOM_STEP_TAG})`);
    expect(second).toBe(`${DEAL_CODE} ${SEPARATOR} A - B (9a8b7c6d)`);
    expect(first).not.toBe(second);
  });

  it('cuts only the title of an over-long step, keeping code and step id', async () => {
    const shared = 'Q'.repeat(300);
    const first = await provisionCustom(CUSTOM_STEP_ID, `${shared} one`);
    const second = await provisionCustom(OTHER_STEP_ID, `${shared} two`);

    for (const name of [first, second]) {
      expect(name?.length).toBeLessThanOrEqual(BOX_NAME_MAX_LENGTH);
      expect(name?.startsWith(`${DEAL_CODE} ${SEPARATOR} QQQ`)).toBe(true);
    }
    expect(first?.length).toBe(BOX_NAME_MAX_LENGTH);
    expect(first?.endsWith(` (${CUSTOM_STEP_TAG})`)).toBe(true);
    expect(second?.endsWith(' (9a8b7c6d)')).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe('fileBytesToStepDataroom records the run that produced the document', () => {
  function filingAdmin() {
    return makeAdmin({
      datarooms: [
        ...DATAROOM_STEP_DEFS.map(() => ({ data: { id: 'seeded' }, error: null })),
        { data: dataroomRow(CUSTOM_STEP_ID), error: null },
        { data: provisionedRow(CUSTOM_STEP_ID), error: null },
      ],
      documents: [{ data: { id: 'doc-1' }, error: null }],
      audit_log: [{ data: null, error: null }],
    });
  }

  it('writes the run id onto the documents row and names the folder from the title', async () => {
    const { admin, inserts } = filingAdmin();

    const filed = await fileBytesToStepDataroom({
      admin,
      dealId: DEAL_ID,
      dealCode: DEAL_CODE,
      stepId: CUSTOM_STEP_ID,
      stepTitle: CUSTOM_STEP_TITLE,
      fileName: 'update.docx',
      bytes: Buffer.from('hello'),
      uploadedBy: 'user-1',
      stepSkillRunId: RUN_ID,
    });

    expect(filed.documentId).toBe('doc-1');
    expect(lastFolderName()).toBe(
      `${DEAL_CODE} ${SEPARATOR} ${CUSTOM_STEP_TITLE} (${CUSTOM_STEP_TAG})`,
    );
    const document = inserts.find((entry) => entry.table === 'documents');
    expect(document?.payload.step_skill_run_id).toBe(RUN_ID);
  });

  it('writes null when the run id is a control plane agent run', async () => {
    const { admin, inserts } = filingAdmin();

    await fileBytesToStepDataroom({
      admin,
      dealId: DEAL_ID,
      dealCode: DEAL_CODE,
      stepId: CUSTOM_STEP_ID,
      stepTitle: CUSTOM_STEP_TITLE,
      fileName: 'update.docx',
      bytes: Buffer.from('hello'),
      uploadedBy: 'user-1',
      stepSkillRunId: AGENT_RUN_ID,
    });

    const document = inserts.find((entry) => entry.table === 'documents');
    expect(document?.payload).toHaveProperty('step_skill_run_id', null);
  });

  it('sends Box a safe file name and keeps the filed name on the row (#328)', async () => {
    const { admin, inserts } = filingAdmin();

    await fileBytesToStepDataroom({
      admin,
      dealId: DEAL_ID,
      dealCode: DEAL_CODE,
      stepId: CUSTOM_STEP_ID,
      stepTitle: CUSTOM_STEP_TITLE,
      fileName: 'update\u0007 draft.docx.',
      bytes: Buffer.from('hello'),
      uploadedBy: 'user-1',
    });

    expect(boxState.uploads.at(-1)?.fileName).toMatch(/^[0-9a-f]{8}-update draft\.docx$/);
    const document = inserts.find((entry) => entry.table === 'documents');
    expect(document?.payload.name).toBe('update\u0007 draft.docx.');
  });

  it('sends Box a distinct name for each filing of the same file (#328)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const { admin, inserts } = filingAdmin();
      await fileBytesToStepDataroom({
        admin,
        dealId: DEAL_ID,
        dealCode: DEAL_CODE,
        stepId: CUSTOM_STEP_ID,
        stepTitle: CUSTOM_STEP_TITLE,
        fileName: 'update.docx',
        bytes: Buffer.from('hello'),
        uploadedBy: 'user-1',
      });
      const document = inserts.find((entry) => entry.table === 'documents');
      expect(document?.payload.name).toBe('update.docx');
    }

    const [first, second] = boxState.uploads.map((upload) => upload.fileName);
    expect(first).toMatch(/^[0-9a-f]{8}-update\.docx$/);
    expect(second).toMatch(/^[0-9a-f]{8}-update\.docx$/);
    expect(first).not.toBe(second);
  });

  it('writes null when no run id is supplied', async () => {
    const { admin, inserts } = filingAdmin();

    await fileBytesToStepDataroom({
      admin,
      dealId: DEAL_ID,
      dealCode: DEAL_CODE,
      stepId: CUSTOM_STEP_ID,
      stepTitle: CUSTOM_STEP_TITLE,
      fileName: 'update.docx',
      bytes: Buffer.from('hello'),
      uploadedBy: 'user-1',
    });

    const document = inserts.find((entry) => entry.table === 'documents');
    expect(document?.payload).toHaveProperty('step_skill_run_id', null);
  });
});
