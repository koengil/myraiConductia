import { createSupabaseServerClient } from '@/lib/supabase/server';

export type Viewer = { isExternal: boolean; firmRole: string | null };

/**
 * The signed-in viewer's side and firm role. Read with the viewer's own
 * session: their users row is readable under users_select. Null when nobody
 * is signed in or the row cannot be read.
 */
export async function currentViewer(): Promise<Viewer | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase.from('users').select('is_external, firm_role').eq('id', user.id).maybeSingle();
    if (!data) return null;
    return { isExternal: data.is_external === true, firmRole: (data.firm_role as string | null) ?? null };
  } catch {
    return null;
  }
}
