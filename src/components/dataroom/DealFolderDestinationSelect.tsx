'use client';

import * as React from 'react';

import {
  DEFAULT_DEAL_FOLDER,
  listFilingDestinations,
  type DealFolder,
} from '@/lib/dataroom/taxonomy';

const DESTINATIONS = listFilingDestinations();

export function destinationKey(folder: DealFolder, subpath: readonly string[]): string {
  return JSON.stringify({ folder, subpath });
}

export const DEFAULT_DESTINATION_KEY = destinationKey(DEFAULT_DEAL_FOLDER, []);

export function parseDestinationKey(value: string): {
  folder: DealFolder;
  subpath: string[];
} {
  return JSON.parse(value) as { folder: DealFolder; subpath: string[] };
}

export function appendFilingDestination(body: FormData, key: string): void {
  const parsed = parseDestinationKey(key);
  body.append('folder', parsed.folder);
  body.append('folderSubpath', JSON.stringify(parsed.subpath));
}

const DEFAULT_SELECT_CLASS =
  'rounded-[var(--radius-button)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-2)] py-[5px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

/**
 * Where a newly uploaded file is filed in the Deal Folder.
 *
 * Required on every upload path (Deal Folder, Data Room, rail-step artifact).
 * The file stays there — there is no later move. A surface that files into
 * another room names the choice itself (`label`) and offers only the folders
 * that fit it (`folders`).
 */
export function DealFolderDestinationSelect({
  value,
  onChange,
  disabled,
  className,
  label = 'Deal folder',
  folders,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
  /** Only these top-level folders (and their subfolders); every folder when absent. */
  folders?: readonly DealFolder[];
}) {
  const destinations = folders ? DESTINATIONS.filter((item) => folders.includes(item.folder)) : DESTINATIONS;
  return (
    <label className="flex min-w-[220px] flex-1 flex-col gap-[4px]">
      <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--ink-tertiary)]">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        required
        aria-required="true"
        className={className ?? DEFAULT_SELECT_CLASS}
      >
        {destinations.map((item) => (
          <option key={item.label} value={destinationKey(item.folder, item.subpath)}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
