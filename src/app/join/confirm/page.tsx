import { notFound } from 'next/navigation';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import ConfirmJoinClient from './page.client';

export const dynamic = 'force-dynamic';

/** Work-identity confirmation (#316 section 4): name, firm, role, deal, terms. */
export default async function ConfirmJoinPage() {
  if (!(await isFlagEnabled('work_identity_onboarding'))) notFound();
  return <ConfirmJoinClient />;
}
