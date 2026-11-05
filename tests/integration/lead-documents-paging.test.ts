import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClient } from '@supabase/supabase-js';

import {
  contentHashOf,
  documentRead,
  getLeadDocument,
  listLeadDocuments,
  persistLeadDocument,
} from '@/lib/conductia/documents';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const LEAD = `PL24-${RUN.toUpperCase()}`;
const ASTRAL_TEXT = 'Founder call \u{1F600} résumé\nNext step: data room.';

const filedIds: string[] = [];

beforeAll(async () => {
  const rows = [
    { title: 'Debrief', text: ASTRAL_TEXT },
    { title: 'Teaser draft', text: null },
    { title: 'MD brief', text: 'The brief.' },
  ];
  for (const [index, row] of rows.entries()) {
    const id = `doc_pl24_${index}_${RUN}`;
    const { error } = await db.from('lead_documents').insert({
      id,
      tenant_id: 'tn_demo',
      lead_id: LEAD,
      title: row.title,
      document_type: 'other',
      folder: 'md-brief',
      text_content: row.text,
      created_at: new Date(Date.UTC(2026, 9, 16, 9, index)).toISOString(),
    });
    if (error) throw new Error(`lead_documents seed failed: ${error.message}`);
    filedIds.push(id);
  }
});

afterAll(async () => {
  await db.from('lead_documents').delete().eq('lead_id', LEAD);
});

describe('lead document list against Postgres (PL-24)', () => {
  it('pages newest first and the cursor reaches every document exactly once', async () => {
    const first = await listLeadDocuments(db, LEAD, { limit: 2, offset: 0 });
    expect(first.documents.map((doc) => doc.documentId)).toEqual([filedIds[2], filedIds[1]]);
    expect(first.nextOffset).toBe(2);

    const second = await listLeadDocuments(db, LEAD, { limit: 2, offset: first.nextOffset! });
    expect(second.documents.map((doc) => doc.documentId)).toEqual([filedIds[0]]);
    expect(second.nextOffset).toBeNull();
  });

  it('summarizes each document exactly as its full read does, without the text', async () => {
    const { documents } = await listLeadDocuments(db, LEAD, { limit: 200, offset: 0 });
    for (const summary of documents) {
      expect(summary).not.toHaveProperty('text');
      const full = documentRead((await getLeadDocument(db, LEAD, summary.documentId))!, 'md-briefing', 'run_1');
      expect({ contentHash: summary.contentHash, charLength: summary.charLength }).toEqual({
        contentHash: full.contentHash,
        charLength: full.charLength,
      });
    }
    const debrief = documents.find((doc) => doc.documentId === filedIds[0])!;
    expect(debrief.charLength).toBe(ASTRAL_TEXT.length);
    expect(debrief.contentHash).toBe(contentHashOf(ASTRAL_TEXT));
    expect(documents.find((doc) => doc.documentId === filedIds[1])).toMatchObject({
      contentHash: null,
      charLength: null,
    });
  });

  it('keeps the summary in step when a filing replaces the text', async () => {
    await persistLeadDocument(db, {
      tenantId: 'tn_demo',
      leadId: LEAD,
      title: 'MD brief',
      documentType: 'other',
      folder: 'md-brief',
      text: 'The revised brief.',
      documentId: filedIds[2],
    });
    const { documents } = await listLeadDocuments(db, LEAD, { limit: 200, offset: 0 });
    expect(documents.find((doc) => doc.documentId === filedIds[2])).toMatchObject({
      version: 2,
      contentHash: contentHashOf('The revised brief.'),
      charLength: 'The revised brief.'.length,
    });
  });
});
