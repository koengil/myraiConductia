import { notFound } from 'next/navigation';

import { BookDeal } from '@/components/book/BookDeal';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';

export const dynamic = 'force-dynamic';

/**
 * `/projects/[projectId]/book` — the Book deal view (#191 slice 2).
 *
 * A SIBLING of `/rail`, never a replacement: the deck-mockup (slide 10)
 * drill-down — phase roll-up + Deal Console — reading the same deal data the
 * rail reads, touching none of the rail's code. The route exists only with
 * the book_view flag on (404 otherwise), same lock as the home switcher.
 */
export default async function BookDealPage() {
  if (!(await isEnabled('book_view', supabaseFlagSource))) notFound();
  return <BookDeal />;
}
