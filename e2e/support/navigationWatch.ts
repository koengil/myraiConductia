import type { Page } from '@playwright/test';

export type NavigationWatch = {
  reset(): void;
  readonly count: number;
};

export function watchNavigations(page: Page): NavigationWatch {
  let count = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) count += 1;
  });
  return {
    reset() {
      count = 0;
    },
    get count() {
      return count;
    },
  };
}
