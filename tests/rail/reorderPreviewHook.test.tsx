import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { applyPreviewOrder, movedInOrder, useReorderPreview } from '@/lib/rail/railPreview';

const SAVED = ['A', 'B', 'C'];

function setup() {
  const hook = renderHook(() => useReorderPreview('deal-1'));
  const shown = () => hook.result.current.order[2] ?? SAVED;
  const move = (id: string, toIndex: number) =>
    act(() => {
      hook.result.current.move(2, shown(), id, toIndex, SAVED);
    });
  return { hook, shown, move };
}

describe('reorder Preview marks come from the order', () => {
  it('keeps a differing order marked after moves that each return a step to its saved place', () => {
    const { hook, shown, move } = setup();
    move('B', 2); // [A, C, B]
    move('A', 2); // [C, B, A]
    move('A', 0); // [A, C, B]

    expect(shown()).toEqual(['A', 'C', 'B']);
    expect(hook.result.current.active).toBe(true);
    expect(hook.result.current.moved.size).toBeGreaterThan(0);
    // A sits in its saved place, so it carries no mark.
    expect(hook.result.current.moved.has('A')).toBe(false);
  });

  it('clears every mark once the phase is back in its saved order', () => {
    const { hook, move } = setup();
    move('B', 2); // [A, C, B]
    expect(hook.result.current.moved).toEqual(new Set(['B']));
    move('B', 1); // [A, B, C]

    expect(hook.result.current.active).toBe(false);
    expect(hook.result.current.moved.size).toBe(0);
    expect(hook.result.current.order).toEqual({});
  });

  it('marks the step just moved, not the steps that shifted to make room', () => {
    const { hook, move } = setup();
    move('A', 2); // [B, C, A]
    expect(hook.result.current.moved).toEqual(new Set(['A']));
  });

  it('keeps other phases marked when one phase changes', () => {
    const hook = renderHook(() => useReorderPreview('deal-1'));
    act(() => {
      hook.result.current.move(1, ['X', 'Y'], 'X', 1, ['X', 'Y']);
    });
    act(() => {
      hook.result.current.move(2, SAVED, 'C', 0, SAVED);
    });
    expect(hook.result.current.moved).toEqual(new Set(['X', 'C']));
    act(() => hook.result.current.reset());
    expect(hook.result.current.active).toBe(false);
  });
});

describe('movedInOrder', () => {
  it('is empty for the saved order and ignores steps the saved order does not name', () => {
    expect(movedInOrder(SAVED, SAVED)).toEqual([]);
    expect(movedInOrder(['A', 'N', 'B', 'C'], SAVED)).toEqual([]);
  });

  it('marks the fewest steps that explain the order, preferring the one just moved', () => {
    expect(movedInOrder(['B', 'C', 'A'], SAVED)).toEqual(['A']);
    expect(movedInOrder(['A', 'C', 'B'], SAVED, 'C')).toEqual(['C']);
    expect(movedInOrder(['A', 'C', 'B'], SAVED, 'B')).toEqual(['B']);
    expect(movedInOrder(['C', 'B', 'A'], SAVED)).toHaveLength(2);
  });
});

describe('a removed step leaves the Preview', () => {
  it('drops the only moved step: no order, no marks, not active', () => {
    const { hook, move } = setup();
    move('B', 2); // [A, C, B]
    expect(hook.result.current.active).toBe(true);
    act(() => hook.result.current.drop(2, 'B', SAVED));
    expect(hook.result.current.active).toBe(false);
    expect(hook.result.current.moved.size).toBe(0);
    expect(hook.result.current.order).toEqual({});
  });

  it('keeps the rest of a differing order, and a restore comes back at its saved place', () => {
    const { hook, move } = setup();
    move('C', 0); // [C, A, B]
    move('B', 0); // [B, C, A]
    act(() => hook.result.current.drop(2, 'B', SAVED));
    // [C, A] still differs from the saved [A, C].
    expect(hook.result.current.active).toBe(true);
    expect(hook.result.current.order[2]).toEqual(['C', 'A']);
    expect(hook.result.current.moved.has('B')).toBe(false);
    // Restored: B is not named by the order, so it takes its saved place (after A).
    const restored = applyPreviewOrder(
      SAVED.map((id) => ({ id }) as never),
      hook.result.current.order[2],
    ).map((s) => (s as { id: string }).id);
    expect(restored).toEqual(['C', 'A', 'B']);
  });
});
