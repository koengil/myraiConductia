// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { logServerEvent, type ServerLine } from '@/lib/log';
import { FIELD_TABLE } from '@/lib/log/fields';

import { captureConsole, type ConsoleCapture } from '../helpers/consoleCapture';
import { LINES } from './lines';

// What mail can put in a value: a subject, a deal name, an address, the #331 canary, and
// uppercase five-letter tokens that pass every code-shape check (a deal-code prefix, a ticker).
const CANARIES = ['Project Falcon', 'Re: Atlassian LOI', 'jane@bank.example', 'CANARY-331', 'ALPHA', 'FALCO', 'ACME1'];

let capture: ConsoleCapture | undefined;
afterEach(() => capture?.restore());

// One base line per event; each case plants the canaries in one field of it.
const bases = LINES.filter(({ line }, i) => LINES.findIndex((l) => l.line.evt === line.evt) === i);
const cases = bases.flatMap(({ line }) => Object.keys(FIELD_TABLE[line.evt]).map((field) => ({ evt: line.evt, field, line })));

describe('mail-derived values never reach a server log line (#474, design Q7)', () => {
  it.each(cases)('logs every canary in $evt.$field as invalid', ({ field, line }) => {
    capture = captureConsole();
    for (const canary of CANARIES) logServerEvent({ ...line, [field]: canary } as unknown as ServerLine);
    const out = capture.lines().map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(out.map((l) => l[field])).toEqual(CANARIES.map(() => 'invalid'));
    for (const canary of CANARIES) expect(capture.output()).not.toContain(canary);
  });

  it('rejects a canary as the event name', () => {
    capture = captureConsole();
    for (const canary of CANARIES) logServerEvent({ evt: canary } as unknown as ServerLine);
    expect(capture.lines()).toEqual(CANARIES.map(() => '{"evt":"log_line_rejected"}'));
  });
});
