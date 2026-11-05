import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import type { LedgerRow } from '@/lib/discovery/persist';

/**
 * An in-memory service client for the real persistItems and syncSource (#460): just the calls they make, so a test
 * can run a pass end to end without Postgres. It keeps source items by Message-ID (insert, never update, as the real
 * upsert with ignoreDuplicates does), document ids, texts and the ledger, and records every content_sources patch.
 * `held` seeds items the tenant already stores, so a sighting can collide with one.
 */
export function memoryPersistDb(
  options: { held?: Array<{ internetMessageId: string; contentHash: string; subject?: string; bodyText?: string }> } = {},
) {
  let next = 0;
  const newId = () => `00000000-0000-4000-8000-${String((next += 1)).padStart(12, '0')}`;
  type ItemRow = { id: string; internet_message_id: string; subject: string | null; content_hash: string };
  const items = new Map<string, ItemRow>();
  const documents = new Map<string, string>();
  const texts = new Map<string, string>();
  const ledger = new Map<string, LedgerRow>();
  const patches: Array<Record<string, unknown>> = [];
  for (const held of options.held ?? []) {
    const id = newId();
    items.set(held.internetMessageId, {
      id,
      internet_message_id: held.internetMessageId,
      subject: held.subject ?? '',
      content_hash: held.contentHash,
    });
    texts.set(id, held.bodyText ?? '');
  }
  const ok = <T>(data: T) => ({ data, error: null });
  const keep = (rows: LedgerRow[]) => {
    for (const row of rows) ledger.set(`${row.source_id}\u0000${row.provider_item_id}`, row);
  };

  const from = (table: string) => ({
    upsert(rows: Array<Record<string, unknown>>) {
      let data: unknown = null;
      if (table === TABLE.SOURCE_ITEMS) {
        const documentRows: Array<{ id: string; drive_item_key: string }> = [];
        for (const row of rows) {
          if (row.kind === 'document') {
            const key = row.drive_item_key as string;
            if (!documents.has(key)) documents.set(key, newId());
            documentRows.push({ id: documents.get(key)!, drive_item_key: key });
            continue;
          }
          const key = row.internet_message_id as string;
          if (!items.has(key)) {
            items.set(key, {
              id: newId(),
              internet_message_id: key,
              subject: (row.subject as string | null) ?? null,
              content_hash: row.content_hash as string,
            });
          }
        }
        data = documentRows;
      } else if (table === TABLE.SOURCE_ITEM_TEXTS) {
        for (const row of rows) texts.set(row.source_item_id as string, row.body_text as string);
      } else if (table === TABLE.ROUTING_LEDGER) {
        keep(rows as LedgerRow[]);
      }
      return Object.assign(Promise.resolve(ok(null)), { select: async () => ok(data) });
    },
    select() {
      // The message index read (#461) finds nothing: every message is processed.
      if (table === TABLE.DISCOVERY_MESSAGE_INDEX) return { eq: () => ({ eq: () => ({ in: async () => ok([]) }) }) };
      return {
        eq: () => ({ in: async (_column: string, keys: string[]) => ok(keys.map((key) => items.get(key)).filter(Boolean)) }),
        in: async (_column: string, ids: string[]) =>
          ok(ids.filter((id) => texts.has(id)).map((id) => ({ source_item_id: id, body_text: texts.get(id) }))),
      };
    },
    update(patch: Record<string, unknown>) {
      return {
        eq: async () => {
          patches.push({ table, ...patch });
          return ok(null);
        },
      };
    },
  });

  // Only the policy-skip call writes ledger rows; the message index writer (#461) is accepted and kept nowhere.
  const rpc = async (name: string, args: { p_rows?: LedgerRow[] }) => {
    if (name === 'discovery_ledger_record_policy_skips') keep(args.p_rows ?? []);
    return ok(null);
  };

  return { db: { from, rpc } as unknown as SupabaseClient, items, ledger, patches };
}

/** The ledger's decisions, counted: routed, unrouted and skipped rows. */
export function ledgerDecisions(ledger: ReadonlyMap<string, LedgerRow>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of ledger.values()) counts[row.decision] = (counts[row.decision] ?? 0) + 1;
  return counts;
}
