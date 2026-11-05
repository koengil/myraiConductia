// An inline server action inside a page: the directive sits in the function body.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export default function Page() {
  async function readSubjects() {
    'use server';
    await createSupabaseAdminClient().from('source_items').select('subject');
  }
  return <form action={readSubjects} />;
}
