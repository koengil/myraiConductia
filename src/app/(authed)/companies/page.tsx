import { redirect } from 'next/navigation';

/**
 * The platform-level Company Search was retired. Leads is the company
 * surface now; keep this route so old bookmarks do not 404.
 */
export default function CompaniesPage() {
  redirect('/leads');
}
