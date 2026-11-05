'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import { isRunnableBenchSkill } from '@/lib/ignatious/bench';
import {
  listBenchSkillVersions,
  readBenchEvents,
  type BenchChatRequest,
  type BenchDefaultModel,
  type BenchModelAlias,
  type BenchSkill,
  type BenchSkillVersion,
} from '@/lib/ignatious/client';
import {
  describeProcessTag,
  modelsWithinCeiling,
  skillMatchesProcessTag,
  type ProcessTag,
} from '@/lib/ignatious/processTag';

export type Turn = { role: 'user' | 'assistant'; content: string };

export function BenchTurn({ turn }: { turn: Turn }) {
  return turn.role === 'assistant' ? (
    <div className="mb-2 text-[length:var(--text-sm)]">
      <span className="font-medium">Bench: </span>
      <Markdown>{turn.content}</Markdown>
    </div>
  ) : (
    <p className="mb-2 whitespace-pre-wrap text-[length:var(--text-sm)]">
      <span className="font-medium">You: </span>
      {turn.content}
    </p>
  );
}

export function BenchChat({
  skills,
  defaultModel,
  loadError,
  startChat,
  selection,
  lockSelection = false,
  heading,
  intro,
}: {
  skills: BenchSkill[];
  defaultModel: BenchDefaultModel | null;
  loadError?: string | null;
  startChat: (body: BenchChatRequest) => Promise<Response>;
  selection?: ProcessTag | null;
  lockSelection?: boolean;
  heading: string;
  intro: string;
}) {
  const scoped = (selection
    ? skills.filter((skill) => skillMatchesProcessTag(skill.tag, selection) && skill.tag?.stageId !== 'always')
    : skills
  ).filter(isRunnableBenchSkill);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<BenchSkill | null>(() =>
    scoped.length === 1 ? scoped[0] : null,
  );
  const modelChoices = modelsWithinCeiling(selected?.maxModel ?? null);
  const [model, setModel] = React.useState<BenchModelAlias | ''>('');
  const [draft, setDraft] = React.useState('');
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [cost, setCost] = React.useState<number | null>(null);
  const [resolvedModel, setResolvedModel] = React.useState<string | null>(null);
  const [versions, setVersions] = React.useState<BenchSkillVersion[] | null>(null);
  const conversationId = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void listBenchSkillVersions(selected.name)
      .then((body) => {
        if (!cancelled) setVersions(body.versions);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const visible = scoped
    .filter((skill) => skill.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 40);

  function restart() {
    conversationId.current = null;
    setTurns([]);
    setCost(null);
    setError(null);
    setResolvedModel(null);
  }

  async function send() {
    const message = draft.trim();
    if (!message || pending) return;
    setDraft('');
    setError(null);
    setPending(true);
    setTurns((prev) => [...prev, { role: 'user', content: message }]);

    const addressed = selected ? `/${selected.name}\n\n${message}` : message;
    let reply = '';
    try {
      const response = await startChat({
        message: addressed,
        conversationId: conversationId.current,
        selection: selected?.tag ?? selection ?? null,
        model: model && modelChoices.includes(model) ? model : null,
      });
      if (!response.body) throw new Error('Skill bench returned an empty stream.');

      for await (const event of readBenchEvents(response.body)) {
        if (event.type === 'ready' && typeof event.conversationId === 'string') {
          conversationId.current = event.conversationId;
          const alias = typeof event.modelAlias === 'string' ? event.modelAlias : null;
          const id = typeof event.model === 'string' ? event.model : null;
          const from = typeof event.modelFrom === 'string' ? event.modelFrom : null;
          setResolvedModel([alias ?? id, from].filter(Boolean).join(' · ') || null);
        }
        if (event.type === 'text' && typeof event.text === 'string') {
          reply += (reply === '' ? '' : '\n\n') + event.text;
        }
        if (event.type === 'done' && typeof event.costUsd === 'number') {
          setCost(event.costUsd);
        }
        if (event.type === 'error' && typeof event.message === 'string') {
          throw new Error(event.message);
        }
      }
      if (reply) setTurns((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (reply) setTurns((prev) => [...prev, { role: 'assistant', content: reply }]);
    } finally {
      setPending(false);
    }
  }

  const defaultHint = defaultModel?.alias ?? defaultModel?.modelId ?? 'deployment default';

  return (
    <section
      aria-label={heading}
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]"
    >
      <div>
        <p className="eyebrow">Sandbox</p>
        <h3 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
          {heading}
        </h3>
        <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{intro}</p>
      </div>

      {loadError ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {loadError}
        </p>
      ) : (
        <>
          {lockSelection && selection ? (
            <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              Scoped to {describeProcessTag(selection)}
              {scoped.length ? ` · ${scoped.length} skill${scoped.length === 1 ? '' : 's'}` : ''}.
              Output is not deal-safe.
            </p>
          ) : (
            <label className="block">
              <span className="bank-label">Find a skill</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`${scoped.length} skills loaded`}
                className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
              />
            </label>
          )}

          <div className="flex max-h-36 flex-wrap gap-[var(--space-2)] overflow-auto">
            {visible.map((skill) => (
              <button
                key={skill.name}
                type="button"
                onClick={() => {
                  setSelected(skill.name === selected?.name ? null : skill);
                  setVersions(null);
                  restart();
                }}
                className={[
                  'rounded-[var(--radius-pill)] border px-[var(--space-3)] py-1 text-[length:var(--text-xs)] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]',
                  selected?.name === skill.name
                    ? 'border-[var(--ai)] bg-[var(--ai-soft)] text-[var(--ai-deep)]'
                    : 'border-[var(--stroke)] bg-[var(--surface)] text-[var(--ink-secondary)] hover:border-[var(--stroke-strong)]',
                ].join(' ')}
              >
                {skill.name}
                {skill.version != null ? ` · v${skill.version}` : ''}
              </button>
            ))}
            {visible.length === 0 ? (
              <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                No bench skill is tagged to this step yet. The turn can still run against utilities.
              </p>
            ) : null}
          </div>

          {selected ? (
            <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              {selected.description ?? selected.name}
              {selected.model ? ` · default ${selected.model}` : ''}
              {selected.maxModel ? ` · ceiling ${selected.maxModel}` : ''}
              {versions && versions.length > 0
                ? ` · versions ${versions.map((row) => (row.current ? `${row.version}*` : row.version)).join(', ')}`
                : selected.version != null
                  ? ` · live v${selected.version}`
                  : ''}
              . Changing the skill starts a new conversation.
            </p>
          ) : (
            <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              {selection
                ? `No named skill selected. The bench loads ${describeProcessTag(selection)} plus always-on utilities.`
                : 'No filter: the bench may load every skill.'}
            </p>
          )}

          <label className="block max-w-xs">
            <span className="bank-label">Model this turn</span>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value as BenchModelAlias | '')}
              className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
            >
              <option value="">Auto · {defaultHint}</option>
              {modelChoices.map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
            </select>
          </label>

          <div className="max-h-64 overflow-auto rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
            {turns.length === 0 ? (
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                The skill&apos;s reply will land here. Type what you want it to produce, then Send.
              </p>
            ) : (
              turns.map((turn, index) => <BenchTurn key={`${turn.role}-${index}`} turn={turn} />)
            )}
            {pending ? (
              <p className="text-[length:var(--text-sm)] font-medium text-[var(--ai-deep)]">Running…</p>
            ) : null}
          </div>

          <div className="flex gap-[var(--space-2)]">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={pending}
              placeholder="What should this skill draft?"
              className="flex-1 rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={pending || !draft.trim()}
              className="rounded-[var(--radius-button)] bg-[var(--ai)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-semibold text-[var(--accent-contrast)] transition-colors duration-150 hover:bg-[var(--ai-deep)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2"
            >
              Send
            </button>
            {turns.length > 0 ? (
              <button
                type="button"
                onClick={restart}
                className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
              >
                New chat
              </button>
            ) : null}
          </div>
          {resolvedModel || cost != null ? (
            <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              {[resolvedModel, cost != null ? `$${cost.toFixed(2)}` : null].filter(Boolean).join(' · ')}
            </p>
          ) : null}
        </>
      )}

      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}
