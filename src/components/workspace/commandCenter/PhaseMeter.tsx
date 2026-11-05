import type { DealRow, PhaseSegment } from '@/lib/deals/commandCenter';

const SEGMENT_CLASS: Record<PhaseSegment, string> = {
  done: 'bg-[var(--positive-fill)]',
  current: 'bg-[color-mix(in_srgb,var(--ink)_22%,transparent)]',
  todo: 'bg-[var(--surface-subtle)]',
};

/** The five phases as one meter: done (green), current (filled to its % done), remaining (gray). */
export function PhaseMeter({ row }: { row: DealRow }) {
  const label =
    row.phaseIndex == null
      ? 'No phase yet'
      : `${row.phase}${row.phasePercent != null ? `, ${row.phasePercent}% done` : ''}`;
  return (
    <span role="img" aria-label={label} className="flex w-full max-w-[160px] gap-[3px]" data-testid="phase-meter">
      {row.meter.map((state, i) => (
        <span
          key={i}
          data-state={state}
          className={`relative h-[5px] flex-1 overflow-hidden rounded-[3px] ${SEGMENT_CLASS[state]}`}
        >
          {state === 'current' && row.phasePercent ? (
            <span
              className="absolute inset-y-0 left-0 rounded-[3px] bg-[var(--ink)]"
              style={{ width: `${row.phasePercent}%` }}
            />
          ) : null}
        </span>
      ))}
    </span>
  );
}
