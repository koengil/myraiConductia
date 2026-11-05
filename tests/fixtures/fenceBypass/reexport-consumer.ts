// Reads mailbox data through the re-exported constant: the file never names the table.
import type { SupabaseClient } from '@supabase/supabase-js';

import { ITEMS } from './reexport-constant';

export async function read(db: SupabaseClient) {
  return db.from(ITEMS).select('subject'); // FLAG
}
