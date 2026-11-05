// Ways to name a mailbox-derived table or RPC that a regex over the source text
// does not see. Every line marked FLAG must be flagged by the type-based
// detector (tests/helpers/fenceAst.ts), and every other line must stay clean.
import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';

declare const db: SupabaseClient;
declare const tinyClient: { from(name: string): unknown; rpc(name: string): unknown };
declare const pick: 'from' | 'rpc';

export async function variants(name: string, list: string[]) {
  // Clean: tables that are not mailbox-derived, and the look-alike from() calls.
  await db.from('deals');
  await db.from(TABLE.DEALS);
  await db.storage.from('bucket');
  Array.from(new Set(list));
  Buffer.from('a');
  list.includes(name as never);

  // Bypass variants.
  await db.from(TABLE['SOURCE_ITEMS']); // FLAG element access on the table map
  const { SOURCE_ITEMS } = TABLE; // FLAG destructured constant
  await db.from(SOURCE_ITEMS); // FLAG the destructured name reaches from()
  const holder = { items: TABLE.SOURCE_ITEMS }; // FLAG constant stored in an object
  await db.from(holder.items); // FLAG the stored name reaches from()
  await db.from('source_' + 'items'); // FLAG string concatenation
  await db.from(`source_${name}`); // FLAG template with a runtime part
  await db.from(name); // FLAG a string parameter
  await db.from(['source', 'items'].join('_')); // FLAG a computed name
  await db.rpc(name); // FLAG a computed function name
  await db.rpc('app_can_see_item'); // FLAG a literal RPC that reads mailbox data
  const { from } = db; // FLAG destructured from() hides its argument
  from('deals');
  await db.from.call(db, 'deals'); // FLAG from() used without being called
  const bound = db.rpc.bind(db); // FLAG rpc() aliased through bind
  bound('deals');
  await tinyClient[pick]('deals'); // FLAG computed member call on a client
  await db['from']('deals');
}
