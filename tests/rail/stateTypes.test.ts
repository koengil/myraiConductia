import { describe, expect, it } from 'vitest';

import { isMovableStep } from '@/lib/rail/railPreview';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/* `isMovableStep` takes a StepState, so a misspelt state does not compile. */

const step = { id: 'a', stepId: 'custom:a' } as ProjectRailStep;

describe('isMovableStep state type', () => {
  it('accepts the step states and refuses a misspelt one at compile time', () => {
    expect(isMovableStep(step, 'todo')).toBe(true);
    // @ts-expect-error 'todoo' is not a StepState.
    expect(isMovableStep(step, 'todoo')).toBe(false);
  });
});
