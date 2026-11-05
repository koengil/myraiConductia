import { redirect } from 'next/navigation';

/**
 * Per-company research profiles were retired with Company Search. Nested
 * organization routes (/members, /roles) stay; this exact path redirects.
 */
export default function CompanyProfilePage() {
  redirect('/leads');
}
