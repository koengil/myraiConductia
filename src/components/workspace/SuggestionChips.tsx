'use client';

/**
 * SuggestionChips — the suggested-prompt pills under the composer. Each seeds a
 * real, distinct conversation: the Chat templates key off the question (teaser /
 * buyers / diligence / valuation), so varied prompts yield varied answers.
 */

import { ChartNoAxesCombined, FileText, ListChecks, Table2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { fragmentHref } from '@/lib/util/fragment';

const SUGGESTED_PROMPTS: readonly {
  text: string;
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}[] = [
  { text: 'Draft the teaser', Icon: FileText },
  { text: 'Which buyers should we prioritize?', Icon: Table2 },
  { text: 'What diligence questions are buyers pressing on?', Icon: ListChecks },
  { text: 'Sanity-check the valuation range', Icon: ChartNoAxesCombined },
];

export type SuggestionChipsProps = { projectId: string };

export function SuggestionChips({ projectId }: SuggestionChipsProps) {
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {SUGGESTED_PROMPTS.map(({ text, Icon }) => (
        <Link
          key={text}
          href={`/projects/${projectId}/chat${fragmentHref('q', text)}`}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--stroke)] bg-[var(--surface)] px-3.5 py-1.5 text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:border-[var(--stroke-strong)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden />
          {text}
        </Link>
      ))}
    </div>
  );
}
