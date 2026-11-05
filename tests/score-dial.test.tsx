import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreDial } from '../src/components/atoms/ScoreDial';

describe('ScoreDial', () => {
  it('renders the numeric score value', () => {
    render(<ScoreDial value={87} />);
    expect(screen.getByText('87')).toBeInTheDocument();
  });

  it('clamps out-of-range values to 0–100', () => {
    render(<ScoreDial value={140} label="Overflow" />);
    expect(screen.getByText('100')).toBeInTheDocument();
  });
});
