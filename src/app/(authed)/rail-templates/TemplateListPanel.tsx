'use client';

import * as React from 'react';
import { ChevronRight, Search } from 'lucide-react';

import { Menu } from '@/components/overlay';
import { formatDate } from '@/lib/format/date';
import type { RailTemplateSummary } from '@/lib/rail/railTemplateModel';
import { groupTemplates, templateMeta } from './templateListModel';

export function templateKey(template: RailTemplateSummary): string {
  return template.id ?? 'default';
}

/**
 * The template list: a name search and two groups (built in, saved by your
 * firm) over the GET /rail-catalog response, filtered in the browser. Each
 * card opens its template; a saved one has an actions menu with Delete.
 */
export function TemplateListPanel({
  templates,
  loadError,
  openId,
  onOpen,
  onDelete,
}: {
  templates: readonly RailTemplateSummary[] | null;
  loadError: string | null;
  openId: string | null;
  onOpen: (template: RailTemplateSummary) => void;
  onDelete: (template: RailTemplateSummary) => void;
}) {
  const [query, setQuery] = React.useState('');
  const searchId = React.useId();
  const groups = templates ? groupTemplates(templates, query) : [];

  return (
    <section
      aria-label="Rail templates"
      // On a wide screen the list stays in view while a long template scrolls.
      className="flex min-w-0 flex-col gap-[var(--space-3)] lg:sticky lg:top-0 lg:-m-1 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:p-1"
    >
      <label htmlFor={searchId} className="sr-only">
        Search templates
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--ink-tertiary)]"
        />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
          autoComplete="off"
          className="block h-10 w-full rounded-[var(--radius-input)] border border-[var(--stroke-strong)] bg-[var(--surface)] pl-9 pr-3 text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] hover:border-[var(--ink-quiet)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-warm)]"
        />
      </div>

      {loadError ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {loadError}
        </p>
      ) : templates === null ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">Loading templates</p>
      ) : groups.length === 0 ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          No template matches &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : (
        groups.map((group) => {
          const headingId = `template-group-${group.id}`;
          return (
            <div key={group.id} className="flex flex-col gap-[var(--space-2)]">
              <h2
                id={headingId}
                className="flex items-baseline justify-between text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]"
              >
                <span>{group.label}</span>
                {group.id === 'saved' ? (
                  <span className="font-mono text-[var(--ink-tertiary)]">{group.templates.length}</span>
                ) : null}
              </h2>
              <ul aria-labelledby={headingId} className="flex flex-col gap-[var(--space-2)]">
                {group.templates.map((template) => (
                  <TemplateCard
                    key={templateKey(template)}
                    template={template}
                    open={openId === templateKey(template)}
                    onOpen={() => onOpen(template)}
                    onDelete={() => onDelete(template)}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

function TemplateCard({
  template,
  open,
  onOpen,
  onDelete,
}: {
  template: RailTemplateSummary;
  open: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const metaId = React.useId();
  const created = template.createdAt ? `Created ${formatDate(template.createdAt)}` : null;
  return (
    <li
      data-template={templateKey(template)}
      data-open={open ? 'true' : undefined}
      className={[
        'group relative flex items-center gap-[var(--space-2)] rounded-[var(--radius-card)] border bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-3)] transition-colors duration-150',
        'has-[.template-open:focus-visible]:ring-2 has-[.template-open:focus-visible]:ring-[var(--accent)] has-[.template-open:focus-visible]:ring-offset-2 has-[.template-open:focus-visible]:ring-offset-[var(--surface-warm)]',
        open
          ? 'border-[var(--accent)]'
          : 'border-[var(--stroke)] hover:border-[var(--stroke-strong)] hover:bg-[var(--surface-raised)]',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        {/* The name is the card's one button; its hit area covers the card. */}
        <button
          type="button"
          onClick={onOpen}
          aria-current={open ? 'true' : undefined}
          aria-describedby={metaId}
          className="template-open block max-w-full truncate text-left text-[length:var(--text-md)] font-medium text-[var(--ink)] after:absolute after:inset-0 after:rounded-[var(--radius-card)] after:content-[''] focus-visible:outline-none"
        >
          {template.name}
        </button>
        <p id={metaId} className="mt-[2px] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {templateMeta(template)}
          {created ? <span className="text-[var(--ink-tertiary)]"> · {created}</span> : null}
        </p>
      </div>
      {template.id ? (
        <div className="relative z-10">
          <Menu
            label={`Actions for ${template.name}`}
            items={[{ id: 'delete', label: 'Delete template…', destructive: true, onSelect: onDelete }]}
          />
        </div>
      ) : null}
      <ChevronRight
        aria-hidden="true"
        className={[
          'size-4 shrink-0 transition-transform duration-150',
          open ? 'translate-x-0.5 text-[var(--ink)]' : 'text-[var(--ink-tertiary)] group-hover:translate-x-0.5 group-hover:text-[var(--ink)]',
        ].join(' ')}
      />
    </li>
  );
}
