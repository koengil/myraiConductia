import { GATE0_STEP_IDS } from './gate0';
import { PERSISTENT_STEP_IDS } from './dealRail';

export const PROTECTED_STEP_IDS: ReadonlySet<string> = new Set([
  ...GATE0_STEP_IDS,
  ...PERSISTENT_STEP_IDS,
]);
