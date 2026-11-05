'use client';

import * as React from 'react';

import type { Skill } from '@/lib/api/types';
import { getApi } from '@/lib/api';
import { SkillCard } from './SkillCard';

/**
 * SkillShelf — the curated draggable skill deck rail of the deep-dive
 * (experience-spine Step 4: "A skills shelf on the side, displaying the five
 * available skills — four free, one premium-locked."). Rendered on the dark
 * workspace stage; on-dark editorial register, a quiet rail not a feature wall.
 *
 * Loads the skill catalogue once on mount through the API seam
 * (getApi().getSkills() → frozen fixtures). The list is never hardcoded here;
 * the premium skill becomes visibly distinct purely from its own data flag,
 * via SkillCard. A rejected load surfaces an explicit, non-hanging error
 * string (never a permanent "Loading skills…").
 *
 * The cards are the affordance — drag them onto the canvas (or, on touch, use
 * the Canvas "Add to canvas" controls, which run the same code path).
 *
 * 2026-05-24 cleanup: the deck is a fixed-height, internally-scrollable shelf
 * so it does not stretch the page as the catalogue grows. The canvas is the
 * working surface; the shelf is a compact source rail. A live count anchors
 * the header and a thin hairline + masked overflow signal "more below" when
 * the catalogue exceeds the visible window.
 */
export default function SkillShelf() {
  const [skills, setSkills] = React.useState<Skill[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    getApi()
      .getSkills()
      .then((s) => {
        if (active) setSkills(s);
      })
      .catch((err) => {
        if (!active) return;
        console.error('[SkillShelf] getSkills failed', { err });
        setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <aside
      aria-label="Skills shelf"
      className="flex w-full flex-col gap-[var(--space-4)]"
    >
      <header className="flex flex-col gap-[var(--space-1)]">
        <div className="flex items-baseline justify-between gap-[var(--space-3)]">
          <span className="eyebrow text-[var(--ink-tertiary)]">
            Skills
          </span>
          {skills && skills.length > 0 ? (
            <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
              {skills.length}
            </span>
          ) : null}
        </div>
        <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
          Drag a skill onto the canvas. Each one routes through compliance.
        </p>
      </header>

      {failed ? (
        <p
          role="status"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          Skills failed to load.
        </p>
      ) : skills === null ? (
        // Compact skeleton placeholders mirroring the card rhythm so the rail
        // does not collapse then pop when the catalogue resolves.
        <ul className="flex flex-col gap-[var(--space-3)]" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <li
              key={`skill-skel-${i}`}
              className="h-[84px] rounded-[var(--radius-card)] bg-[var(--surface-subtle)]"
            />
          ))}
        </ul>
      ) : (
        // Fixed-height, internally-scrollable deck. The shelf stays a compact
        // source rail no matter how many skills ship; the canvas keeps the
        // visual weight. `lg:max-h-[...]` caps it on the wide layout where the
        // shelf is a sidebar; below lg it lays out naturally above the canvas.
        <ul
          // Internal horizontal padding (with a matching negative margin so the
          // rail still aligns with the header) gives the cards' hover lift
          // (scale 1.02 + shadow) room inside the scroll box. overflow-y:auto
          // also clips the x-axis, so without this the hovered card cut off on
          // the left/right edges.
          className="flex flex-col gap-[var(--space-3)] lg:max-h-[calc(100dvh-var(--shell-header-h)-260px)] lg:overflow-y-auto lg:-mx-[var(--space-2)] lg:px-[var(--space-2)] lg:py-[var(--space-1)] lg:[scrollbar-width:thin]"
        >
          {skills.map((skill) => (
            <li key={skill.id}>
              <SkillCard skill={skill} />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
