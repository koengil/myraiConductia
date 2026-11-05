'use client';

/*
 * Dev-only primitive showcase. Scaffold aid, not product UI.
 * Renders every brand primitive across its variants so the design tokens and
 * Score Reveal motion can be sanity-checked against docs/design/workbench/.
 * Headings are Inter (font-bank): serif (--font-display) is reserved for deal
 * identity + source excerpts, and this page has none.
 */

import * as React from 'react';

import {
  AvatarInitials,
  Button,
  Card,
  Badge,
  Pill,
  ScoreDial,
  SegmentedControl,
} from '@/components/atoms';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-[var(--space-4)]">
      <h2 className="font-bank text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-[var(--space-4)]">
        {children}
      </div>
    </section>
  );
}

const SEGMENTED_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'history', label: 'History' },
] as const;

export default function AtomsPreviewPage() {
  const [segment, setSegment] = React.useState<string>('overview');

  return (
    <main className="min-h-screen bg-[var(--surface-warm)] px-[var(--space-12)] py-[var(--space-12)]">
      <div className="mx-auto flex max-w-3xl flex-col gap-[var(--space-12)]">
        <header className="flex flex-col gap-[var(--space-2)]">
          <h1 className="font-bank text-[length:var(--text-2xl)] font-semibold text-[var(--ink)]">
            Conductia atoms
          </h1>
          <p className="font-sans text-[length:var(--text-base)] text-[var(--ink-secondary)]">
            Token-driven brand atoms. Internal scaffold, not product UI.
          </p>
        </header>

        <Section title="Button">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button variant="primary" size="lg">
            Large
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </Section>

        <Section title="Button on dark">
          <div className="flex flex-wrap items-center gap-[var(--space-4)] rounded-[var(--radius-card)] bg-[var(--canvas-bg)] p-[var(--space-5)]">
            <Button surface="dark" variant="primary">
              Primary
            </Button>
            <Button surface="dark" variant="secondary">
              Secondary
            </Button>
            <Button surface="dark" variant="ghost">
              Ghost
            </Button>
          </div>
        </Section>

        <Section title="Card">
          <Card className="max-w-sm">
            <h3 className="font-bank text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
              Surface card
            </h3>
            <p className="mt-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              Light stroke separation over the white surface token. No heavy
              elevation.
            </p>
          </Card>
          <Card elevation="raised" className="max-w-sm">
            <h3 className="font-bank text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
              Floating card
            </h3>
            <p className="mt-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              The one ambient shadow, reserved for floating surfaces.
            </p>
          </Card>
        </Section>

        <Section title="Badge">
          <Badge tone="neutral">Neutral</Badge>
          <Badge tone="positive">Compliance clear</Badge>
          <Badge tone="hold">Hold for review</Badge>
          <Badge tone="negative">Blocked</Badge>
          <Badge tone="accent">Accent</Badge>
        </Section>

        <Section title="Pill">
          <Pill tone="neutral">Neutral</Pill>
          <Pill tone="positive">Clear</Pill>
          <Pill tone="hold">Held</Pill>
          <Pill tone="negative">Blocked</Pill>
          <Pill tone="accent">Accent</Pill>
        </Section>

        <Section title="SegmentedControl">
          <SegmentedControl
            items={SEGMENTED_ITEMS}
            value={segment}
            onChange={setSegment}
            idBase="dev-primitives-segment"
            aria-label="Primitive showcase views"
          />
        </Section>

        <Section title="AvatarInitials">
          <AvatarInitials initials="SD" />
          <AvatarInitials initials="MC" />
        </Section>

        <Section title="ScoreDial">
          <ScoreDial value={87} label="Anthropic" />
          <ScoreDial value={67} label="Salesforce" />
          <ScoreDial value={42} label="Low band" />
        </Section>
      </div>
    </main>
  );
}
