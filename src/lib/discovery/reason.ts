import { MILESTONE_LABEL, type MilestoneType } from './milestones';
import { formatDate } from '@/lib/format/date';

/** "Sep 18, 2026" from a 'YYYY-MM-DD' day. */
export function reasonDate(isoDay: string): string {
  return formatDate(`${isoDay}T00:00:00Z`, { timeZone: 'UTC' });
}

export function reasonText(title: string, type: MilestoneType, isoDay: string, emails: number): string {
  return `${title} because ${MILESTONE_LABEL[type]} on ${reasonDate(isoDay)} (${emails} ${emails === 1 ? 'email' : 'emails'})`;
}
