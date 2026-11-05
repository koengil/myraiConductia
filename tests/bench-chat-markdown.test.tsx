/**
 * Bench turns: assistant output is agent markdown and renders as such; the user
 * turn came out of an <input> and stays plain text under its inline label.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BenchTurn } from '@/components/ignatious/BenchChat';

describe('BenchChat turn body', () => {
  it('renders an assistant turn as markdown under the Bench label', () => {
    const { container } = render(
      <BenchTurn turn={{ role: 'assistant', content: '## Findings\n\n**bold**' }} />,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Findings');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(screen.getByText('Bench:')).toBeTruthy();
  });

  it('renders a user turn as plain text with its markup intact', () => {
    const { container } = render(
      <BenchTurn turn={{ role: 'user', content: '## not a heading **not bold**' }} />,
    );
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('## not a heading **not bold**');
    expect(screen.getByText('You:')).toBeTruthy();
  });
});
