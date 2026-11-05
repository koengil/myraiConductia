'use client';

import * as React from 'react';

import { listBenchSkills, type BenchDefaultModel, type BenchSkill } from '@/lib/ignatious/client';
import { skillLibraryFailureMessage } from '@/lib/ignatious/failure';
import { describeProcessTag } from '@/lib/ignatious/processTag';

export function BenchCatalog() {
  const [skills, setSkills] = React.useState<BenchSkill[] | null>(null);
  const [defaultModel, setDefaultModel] = React.useState<BenchDefaultModel | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    void listBenchSkills()
      .then((body) => {
        setSkills(body.skills ?? []);
        setDefaultModel(body.defaultModel ?? null);
      })
      .catch((err: unknown) => setError(skillLibraryFailureMessage(err)));
  }, []);

  const visible = (skills ?? []).filter((skill) => {
    const haystack = `${skill.name} ${skill.description ?? ''} ${describeProcessTag(skill.tag)}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  return (
    <section
      aria-label="Ignatious skill bench"
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]"
    >
      <div>
        <p className="eyebrow">Sandbox</p>
        <h2 className="font-sans text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
          Ignatious skill bench
        </h2>
        <p className="mt-1 max-w-[62ch] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          One skill per process step, plus utilities. Versions are integers the bench assigns.
          Model choice is opus, sonnet, or haiku. The default is {defaultModel?.alias ?? defaultModel?.modelId ?? 'the deployment model'}.
          They are not deal-safe. Open a rail step or a lead to run one.
        </p>
      </div>
      {error ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink)]">
          {error}
        </p>
      ) : skills === null ? (
        <p className="w-fit animate-pulse rounded-[var(--radius-input)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)] motion-reduce:animate-none">Loading bench…</p>
      ) : (
        <>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${skills.length} skills`}
            className="w-full max-w-md rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
          <ul className="grid grid-cols-1 gap-[var(--space-2)] sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((skill) => (
              <li
                key={skill.name}
                className="rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] transition-colors duration-150 ease-out hover:bg-[var(--surface-raised)]"
              >
                <p className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                  {skill.name}
                </p>
                <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)] tnum">
                  {describeProcessTag(skill.tag)}
                  {skill.version != null ? ` · v${skill.version}` : ''}
                  {skill.model ? ` · ${skill.model}` : ''}
                  {skill.maxModel ? ` · ceiling ${skill.maxModel}` : ''}
                  {skill.testStatus !== 'untested' ? ` · ${skill.testStatus}` : ''}
                  {!skill.enabled ? ' · off' : ''}
                  {skill.status !== 'ok' && skill.reason ? ` · ${skill.reason}` : ''}
                </p>
                {skill.description ? (
                  <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                    {skill.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
