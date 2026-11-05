import { afterEach, describe, expect, it } from 'vitest';
import { captureConsole, type ConsoleCapture } from './consoleCapture';

let capture: ConsoleCapture | undefined;

afterEach(() => {
  capture?.restore();
  capture = undefined;
});

describe('captureConsole', () => {
  it('finds a canary in a plain string argument', () => {
    capture = captureConsole();
    console.error('provider said CANARY-331');
    expect(capture.output()).toContain('CANARY-331');
  });

  it('finds a canary nested in { err: new Error(...) }', () => {
    capture = captureConsole();
    console.error('[deals] provisioning failed', { dealId: 'd1', err: new Error('CANARY-331 body') });
    expect(capture.output()).toContain('CANARY-331');
    // The pattern this helper replaces renders the wrapper as [object Object].
    const naive = [['[deals] provisioning failed', { dealId: 'd1', err: new Error('CANARY-331 body') }]].flat().join('\n');
    expect(naive).not.toContain('CANARY-331');
  });

  it('finds a canary in an Error cause, an array and a deeply nested value', () => {
    capture = captureConsole();
    console.warn(new Error('outer', { cause: new Error('CANARY-331 cause') }));
    expect(capture.output()).toContain('CANARY-331 cause');
    capture.restore();

    capture = captureConsole();
    console.log([1, 2, { a: { b: { c: { d: 'CANARY-331 deep' } } } }]);
    expect(capture.output()).toContain('CANARY-331 deep');
  });

  it('captures every console method', () => {
    capture = captureConsole();
    console.log('log-line');
    console.info('info-line');
    console.warn('warn-line');
    console.error('error-line');
    console.debug('debug-line');
    expect(capture.lines()).toEqual(['log-line', 'info-line', 'warn-line', 'error-line', 'debug-line']);
  });

  it('joins the arguments of one call on one line', () => {
    capture = captureConsole();
    console.error('[box] upload', 'failed', { code: 'box_409' });
    expect(capture.lines()).toHaveLength(1);
    expect(capture.lines()[0]).toContain('[box] upload failed');
    expect(capture.lines()[0]).toContain('box_409');
  });

  it('does not truncate a long value that hides a canary at the end', () => {
    capture = captureConsole();
    console.error({ body: `${'x'.repeat(20_000)}CANARY-331` });
    expect(capture.output()).toContain('CANARY-331');
  });

  it('stays silent when nothing carries the canary', () => {
    capture = captureConsole();
    console.error('[box] upload failed', { dealId: 'd1', code: 'box_409' });
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('restores the console on restore()', () => {
    const before = console.error;
    capture = captureConsole();
    expect(console.error).not.toBe(before);
    capture.restore();
    expect(console.error).toBe(before);
    capture = undefined;
  });
});
