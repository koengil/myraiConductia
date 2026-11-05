'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import type { CultureFactors } from '@/lib/api/types';
import { clamp0to100 } from '@/lib/util/clamp';
import {
  SCORE_REVEAL_DURATION_S,
  SCORE_REVEAL_EASE,
} from '@/components/_shared/motion';
import { Card } from '@/components/atoms';

export type CultureRadarPanelProps = {
  factors: CultureFactors;
};

/**
 * Culture / psych-fit radar panel — experience-spine Step 4 (a panel rendered
 * on the hero canvas). Seven axes, each 0–100 (matrices.md §3): vision,
 * mission, founder, headcount, industry, product, culture. This is the
 * "AI sees nuance bankers miss" layer, made visible. Light workbench card
 * (kit §10): the radar geometry is unchanged; grid strokes are hairlines and
 * the series reads in ink so it sits as a calm analysis instrument.
 *
 * Motion — Score Reveal (motion-language.md §3): "the radar arms extend from
 * center outward simultaneously, reaching their target values" with a 600ms
 * duration and a slight-overshoot easing `cubic-bezier(0.34, 1.56, 0.64, 1)`.
 * Implemented as a single polygon whose scale animates 0 → 1 from the centroid
 * on mount, so all seven arms grow together. `prefers-reduced-motion` renders
 * the final polygon instantly (scale 1, no transition) — the ScoreDial
 * primitive's reduced-motion precedent.
 *
 * Pure presentational: values come from props, never derived or fetched. The
 * seven axis labels are byte-stable (asserted, panels.test).
 */

// motion-language.md §3 Score Reveal — radar arm extension. Shared with
// ScoreBreakdownPanel via _shared/motion.ts (single source of truth).
const RADAR_DURATION_S = SCORE_REVEAL_DURATION_S; // 600ms
const RADAR_EASE = SCORE_REVEAL_EASE;

type Axis = { id: keyof CultureFactors; label: string };

// Order is the matrices.md §3 factor order.
const AXES: Axis[] = [
  { id: 'vision', label: 'Vision' },
  { id: 'mission', label: 'Mission' },
  { id: 'founder', label: 'Founder' },
  { id: 'headcount', label: 'Headcount' },
  { id: 'industry', label: 'Industry' },
  { id: 'product', label: 'Product' },
  { id: 'culture', label: 'Culture' },
];

const SIZE = 280;
const CENTER = SIZE / 2;
const RADIUS = 96; // outer ring radius
const LABEL_RADIUS = RADIUS + 30;

// Angle for axis i, starting at 12 o'clock and going clockwise.
function angleFor(i: number, count: number): number {
  return -Math.PI / 2 + (i * 2 * Math.PI) / count;
}

function pointAt(angle: number, distance: number): { x: number; y: number } {
  return {
    x: CENTER + Math.cos(angle) * distance,
    y: CENTER + Math.sin(angle) * distance,
  };
}

export function CultureRadarPanel({ factors }: CultureRadarPanelProps) {
  const reduceMotion = useReducedMotion();
  const count = AXES.length;

  const rings = [0.25, 0.5, 0.75, 1];

  const ringPolygons = rings.map((scale) =>
    AXES.map((_, i) => {
      const p = pointAt(angleFor(i, count), RADIUS * scale);
      return `${p.x},${p.y}`;
    }).join(' '),
  );

  const spokes = AXES.map((_, i) => pointAt(angleFor(i, count), RADIUS));

  const dataPoints = AXES.map((axis, i) => {
    const value = clamp0to100(factors[axis.id]);
    return pointAt(angleFor(i, count), RADIUS * (value / 100));
  });
  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <Card aria-label="Culture and psych-fit radar">
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">
          Culture and psych-fit
        </span>
        <h3 className="font-sans text-[length:var(--text-xl)] font-semibold leading-tight text-[var(--ink)]">
          Seven-factor strategic alignment
        </h3>
      </div>

      <div className="mt-[var(--space-8)] flex flex-col items-center gap-[var(--space-8)] lg:flex-row lg:items-center lg:justify-between">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label="Culture factor radar, seven axes scored 0 to 100"
          className="shrink-0"
        >
          {ringPolygons.map((pts, i) => (
            <polygon
              key={`ring-${i}`}
              points={pts}
              fill="none"
              stroke="var(--stroke)"
              strokeWidth={1}
            />
          ))}

          {spokes.map((p, i) => (
            <line
              key={`spoke-${i}`}
              x1={CENTER}
              y1={CENTER}
              x2={p.x}
              y2={p.y}
              stroke="var(--stroke)"
              strokeWidth={1}
            />
          ))}

          <motion.polygon
            points={dataPolygon}
            fill="color-mix(in srgb, var(--ink) 10%, transparent)"
            stroke="var(--ink)"
            strokeWidth={2}
            strokeLinejoin="round"
            style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
            initial={{ scale: reduceMotion ? 1 : 0, opacity: reduceMotion ? 1 : 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { duration: RADAR_DURATION_S, ease: RADAR_EASE }
            }
          />

          {dataPoints.map((p, i) => (
            <motion.circle
              key={`vertex-${i}`}
              cx={p.x}
              cy={p.y}
              r={3}
              fill="var(--ink)"
              initial={{ opacity: reduceMotion ? 1 : 0 }}
              animate={{ opacity: 1 }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { duration: RADAR_DURATION_S, ease: RADAR_EASE }
              }
            />
          ))}

          {AXES.map((axis, i) => {
            const lp = pointAt(angleFor(i, count), LABEL_RADIUS);
            const anchor =
              Math.abs(lp.x - CENTER) < 1
                ? 'middle'
                : lp.x > CENTER
                  ? 'start'
                  : 'end';
            const value = clamp0to100(factors[axis.id]);
            return (
              <text
                key={`label-${axis.id}`}
                x={lp.x}
                y={lp.y}
                textAnchor={anchor}
                dominantBaseline="middle"
                className="font-sans"
                fontSize={11}
              >
                <tspan fill="var(--ink-secondary)">{axis.label}</tspan>
                <tspan
                  x={lp.x}
                  dy={14}
                  fill="var(--ink)"
                  className="tabular-nums"
                  fontWeight={600}
                >
                  {value}
                </tspan>
              </text>
            );
          })}
        </svg>

        <ul className="flex w-full max-w-[240px] flex-col gap-[var(--space-3)]">
          {AXES.map((axis) => (
            <li
              key={axis.id}
              className="flex items-center justify-between gap-[var(--space-4)] border-b border-[var(--stroke)] pb-[var(--space-2)] text-[length:var(--text-sm)] last:border-b-0"
            >
              <span className="font-sans text-[var(--ink-secondary)]">
                {axis.label}
              </span>
              <span className="font-sans font-semibold tabular-nums text-[var(--ink)]">
                {clamp0to100(factors[axis.id])}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export default CultureRadarPanel;
