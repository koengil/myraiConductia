// Captures everything a test writes to the console, as one searchable string.
//
// Each argument is rendered the way Node's console renders it: a top-level
// string as itself, anything else through util.inspect. An Error therefore
// contributes its message and stack, and an object such as `{ dealId, err }`
// contributes every nested value. The `mock.calls.flat().join('\n')` pattern
// renders a wrapping object as `[object Object]` and would miss a canary
// inside it (review C6 in the #331 outline).
//
//   const capture = captureConsole();
//   … run the code under test …
//   expect(capture.output()).not.toContain('CANARY-331');
//   capture.restore();

import { inspect } from 'node:util';
import { vi } from 'vitest';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table'] as const;

// maxStringLength and maxArrayLength are lifted so a long body or a long list
// cannot hide a canary behind inspect's default truncation.
const INSPECT_OPTIONS = { depth: 8, showHidden: false, maxStringLength: null, maxArrayLength: null } as const;

export function renderConsoleArg(arg: unknown): string {
  return typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS);
}

export type ConsoleCapture = {
  /** Every captured call, one line per call, arguments joined by a space. */
  output(): string;
  /** The rendered calls, in order. */
  lines(): string[];
  /** Restores every console method. */
  restore(): void;
};

export function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const spies = METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(renderConsoleArg).join(' '));
    }),
  );
  return {
    output: () => lines.join('\n'),
    lines: () => [...lines],
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
