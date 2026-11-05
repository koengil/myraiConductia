import { redirect } from 'next/navigation';

/**
 * Root entry. The marketing landing is gone — this app is sign-in first.
 * Anonymous visitors are sent to /sign-in by middleware; a signed-in user
 * who hits / lands in the Command Center.
 */
export default function Home() {
  redirect('/projects');
}
