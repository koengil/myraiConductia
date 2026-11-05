'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import { clamp0to100 } from '@/lib/util/clamp';

type Surface = 'light' | 'dark';

export type ScoreDialProps = {
  value: number;
  size?: number;
  label?: string;
  surface?: Surface;
};

const SWEEP_DURATION_S = 0.7;
const SWEEP_EASE = 'easeOut';
const LABEL_HOLD_S = 0.2;
const LABEL_FADE_DURATION_S = 0.2;
const LABEL_EASE = 'easeIn';
const TICK_COUNT = 60;

function bandStroke(score: number): string {
  if (score >= 75) return 'var(--positive)';
  if (score >= 50) return 'var(--hold)';
  return 'var(--negative)';
}

export function ScoreDial({
  value,
  size = 160,
  label,
  surface = 'light',
}: ScoreDialProps) {
  const reduceMotion = useReducedMotion();
  const clamped = clamp0to100(value);

  const stroke = Math.max(6, Math.round(size * 0.075));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const fraction = clamped / 100;
  const labelDelay = reduceMotion ? 0 : SWEEP_DURATION_S + LABEL_HOLD_S;

  const ring = bandStroke(clamped);
  const isDark = surface === 'dark';
  const trackStroke = isDark
    ? 'rgb(245 242 235 / 0.10)'
    : 'var(--surface-subtle)';
  const tickStroke = isDark
    ? 'rgb(245 242 235 / 0.16)'
    : 'var(--stroke)';
  const numeralColor = isDark ? 'var(--ink-on-dark)' : 'var(--ink)';
  const labelColor = isDark
    ? 'var(--ink-on-dark-secondary)'
    : 'var(--ink-secondary)';

  const tickOuter = radius - stroke * 0.5;
  const tickInner = tickOuter - Math.max(3, stroke * 0.5);
  const ticks = React.useMemo(
    () =>
      Array.from({ length: TICK_COUNT }, (_, i) => {
        const angle = (i / TICK_COUNT) * 2 * Math.PI - Math.PI / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return {
          x1: center + cos * tickInner,
          y1: center + sin * tickInner,
          x2: center + cos * tickOuter,
          y2: center + sin * tickOuter,
          key: i,
        };
      }),
    [center, tickInner, tickOuter],
  );

  return (
    <div
      className="inline-flex flex-col items-center gap-[var(--space-2)]"
      role="img"
      aria-label={
        label
          ? `${label}: score ${clamped} out of 100`
          : `Score ${clamped} out of 100`
      }
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <g stroke={tickStroke} strokeWidth={1}>
            {ticks.map((t) => (
              <line key={t.key} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
            ))}
          </g>

          <g style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}>
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={trackStroke}
              strokeWidth={stroke}
            />
            <motion.circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={ring}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{
                strokeDashoffset: reduceMotion
                  ? circumference * (1 - fraction)
                  : circumference,
              }}
              animate={{ strokeDashoffset: circumference * (1 - fraction) }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { duration: SWEEP_DURATION_S, ease: SWEEP_EASE }
              }
            />
          </g>
        </svg>

        <motion.div
          className="absolute inset-0 flex flex-col items-center justify-center"
          initial={{ opacity: reduceMotion ? 1 : 0 }}
          animate={{ opacity: 1 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : {
                  duration: LABEL_FADE_DURATION_S,
                  ease: LABEL_EASE,
                  delay: labelDelay,
                }
          }
        >
          <span
            className="data-xl"
            style={{
              fontSize: Math.round(size * 0.32),
              color: numeralColor,
            }}
          >
            {clamped}
          </span>
        </motion.div>
      </div>

      {label ? (
        <span
          className="font-sans text-[length:var(--text-sm)] font-medium"
          style={{ color: labelColor }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

export default ScoreDial;
