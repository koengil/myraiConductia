import { describe, expect, it } from 'vitest';
import { greetingForHour } from '../src/lib/util/greeting';

describe('greetingForHour', () => {
  it('reads morning until noon', () => {
    expect(greetingForHour(0)).toBe('Good morning.');
    expect(greetingForHour(11)).toBe('Good morning.');
  });

  it('reads afternoon from noon until six', () => {
    expect(greetingForHour(12)).toBe('Good afternoon.');
    expect(greetingForHour(17)).toBe('Good afternoon.');
  });

  it('reads evening from six onwards', () => {
    expect(greetingForHour(18)).toBe('Good evening.');
    expect(greetingForHour(21)).toBe('Good evening.');
    expect(greetingForHour(23)).toBe('Good evening.');
  });
});
