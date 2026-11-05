import { extractDemoMail, seedDemoMail } from '../support/discoveryProcess';
import { assertSeededMailPath } from '../support/mailPath';
import type { Step } from './types';

// Beat 7's late mail arrives mid-journey, which a CI step cannot do: two child
// processes against the local stack (e2e/support/discoveryProcess.ts).
export const importLateMail: Step = {
  name: 'late mail arrives and is extracted',

  async act() {
    seedDemoMail('importLateMail', { afterImports: true });
    extractDemoMail('importLateMail');
  },
  async assertUi() {},
  // The mid-journey re-seed stayed on the project's mail path.
  async verify() {
    await assertSeededMailPath();
  },
};
