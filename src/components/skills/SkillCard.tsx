'use client';

import * as React from 'react';
import { motion, useReducedMotion, type Transition } from 'framer-motion';

import type { Skill } from '@/lib/api/types';
import { Card, Pill, Badge } from '@/components/atoms';

export type SkillCardProps = {
  skill: Skill;
  draggable?: boolean;
};

/**
 * SkillCard — one draggable intelligence unit on the skills shelf
 * (experience-spine Step 4 / skills-catalog). Rendered on the light workbench
 * stage alongside SkillShelf and Canvas, so it uses the Card `light` surface
 * and dark ink — the deck reads as a curated set of intelligence units, not a
 * SaaS feature list.
 *
 * The whole card is the drag affordance. On drag start it writes the skill id
 * to two dataTransfer slots: the namespaced `application/intellibank-skill`
 * (the canvas reads this) and `text/plain` as a robust fallback.
 * `effectAllowed = 'copy'` — dropping composes a panel, it does not move the
 * skill off the shelf.
 *
 * Premium skills (skill.premium) carry a clear lock affordance — a lock glyph
 * plus a "Pro" Badge — and a subtly recessed treatment. They remain fully
 * draggable: dropping a Pro skill is what later triggers the paywall beat
 * (Step 5), so drag must NOT be disabled. The accessible name is exactly
 * `${skill.name}, Pro skill, locked` (a comma: no em dash in visible copy,
 * ARIA names included) so the asserted contract holds byte-stable.
 *
 * Motion — Skill-Transform Stream § step 1 (motion-language.md §2): "Skill
 * card lifts from the shelf (scale up slightly, shadow appears)" at 150ms,
 * ease-out — the documented FIRST beat of the named motion. Implemented as a
 * restrained hover/focus lift (scale 1.02 + a light shadow) on a motion
 * wrapper; the pick-up gesture naturally holds hover through the HTML5 drag.
 * `prefers-reduced-motion` collapses the lift to instant (no scale, no
 * shadow) — the ScoreDial / Canvas / Intent reduced-motion precedent.
 *
 * Presentational only: no fetching, no store. Skill data (id, premium,
 * category) comes from the frozen fixtures via the API seam.
 */

// motion-language.md §2 step 1 — skill lift.
const LIFT_DURATION_S = 0.15; // 150ms
const LIFT_EASE = 'easeOut' as const; // ease-out

export function SkillCard({ skill, draggable = true }: SkillCardProps) {
  const reduceMotion = useReducedMotion();

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('application/intellibank-skill', skill.id);
    // Fallback slot — some drop targets / environments only expose text/plain.
    e.dataTransfer.setData('text/plain', skill.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const liftTransition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: LIFT_DURATION_S, ease: LIFT_EASE };

  // Workbench register: the lift is scale-only — hairlines and a raised
  // wash carry the hover, never a shadow.
  const lift = reduceMotion
    ? undefined
    : {
        scale: 1.02,
      };

  return (
    <motion.div
      className="rounded-[var(--radius-card)]"
      whileHover={lift}
      whileFocus={lift}
      transition={liftTransition}
    >
      <Card
        draggable={draggable}
        onDragStart={draggable ? handleDragStart : undefined}
        aria-label={
          skill.premium
            ? `${skill.name}, Pro skill, locked`
            : `${skill.name} skill`
        }
        data-skill-id={skill.id}
        data-premium={skill.premium ? 'true' : 'false'}
        className={
          'group flex flex-col gap-[var(--space-3)] p-[var(--space-5)] ' +
          'transition-[background-color,opacity] ' +
          'hover:bg-[var(--surface-raised)] hover:ring-[var(--stroke-strong)] ' +
          (draggable ? 'cursor-grab active:cursor-grabbing ' : '') +
          (skill.premium ? 'opacity-70 hover:opacity-100' : '')
        }
      >
        <div className="flex items-start justify-between gap-[var(--space-3)]">
          <h3 className="min-w-0 font-sans text-[length:var(--text-base)] font-medium leading-snug text-[var(--ink)]">
            {skill.name}
          </h3>
          {skill.premium ? (
            <span className="flex shrink-0 items-center gap-[var(--space-2)]">
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[var(--ink-secondary)]"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <Badge tone="accent">
                Pro
              </Badge>
            </span>
          ) : null}
        </div>

        <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
          {skill.description}
        </p>

        <div className="mt-[var(--space-1)]">
          <Pill tone="neutral">
            {skill.category}
          </Pill>
        </div>
      </Card>
    </motion.div>
  );
}

export default SkillCard;
