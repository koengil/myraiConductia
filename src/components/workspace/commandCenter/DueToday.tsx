import Link from 'next/link';

import type { DealRow } from '@/lib/deals/commandCenter';

import { Card, ghostButton } from './Card';

/** Renders nothing unless a deal's target close is today: the only date the
 *  platform holds. Per-step deadlines need stored step dates (handoff E4). */
export function DueToday({ rows }: { rows: DealRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card title="Due today" meta="Target close">
      <ul className="divide-y divide-[var(--stroke)]">
        {rows.map((row) => (
          <li key={row.dealId} className="flex min-h-[52px] items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-[length:var(--text-md)] font-medium text-[var(--ink)]">
                {row.codename} closes today
              </span>
              <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {row.phase} · {row.stepTitle}
              </span>
            </div>
            <Link href={`/projects/${row.code || row.dealId}`} className={ghostButton} aria-label={`Open ${row.codename}`}>
              Open deal
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
