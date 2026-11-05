// A layout that reads mailbox data with the service role.
import type { ReactNode } from 'react';

import { createSupabaseAdminClient } from '@/lib/supabase/server';

export default async function Layout({ children }: { children: ReactNode }) {
  const { count } = await createSupabaseAdminClient().from('source_items').select('id', { count: 'exact', head: true });
  return <div data-count={count}>{children}</div>;
}
