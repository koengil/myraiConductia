import { describe, expect, it } from 'vitest';

import { mailPathRefusal } from '../e2e/support/mailPath';

const graphRows = [
  { address: 'storm.duncan@bank.example', provider: 'microsoft' },
  { address: 'alex.chen@bank.example', provider: 'microsoft' },
];
const googleRows = [
  { address: 'storm.duncan@bank.example', provider: 'google' },
  { address: 'alex.chen@bank.example', provider: 'google' },
];

describe('mailPathRefusal (the demo journey cannot pass on the wrong mail path)', () => {
  it('refuses Graph mailbox sources on the gmail-replay path, naming each one', () => {
    expect(mailPathRefusal('gmail-replay', graphRows)).toBe(
      'storm.duncan@bank.example: microsoft, alex.chen@bank.example: microsoft',
    );
  });

  it('refuses Google mailbox sources on the graph path', () => {
    expect(mailPathRefusal('graph', googleRows)).toBe('storm.duncan@bank.example: google, alex.chen@bank.example: google');
  });

  it('refuses a mix, naming only the sources off the path', () => {
    expect(mailPathRefusal('gmail-replay', [googleRows[0], graphRows[1]])).toBe('alex.chen@bank.example: microsoft');
  });

  it('refuses a tenant with no mailbox sources: a seed that placed nothing proves nothing', () => {
    expect(mailPathRefusal('gmail-replay', [])).toBe('the seed placed no mailbox sources');
    expect(mailPathRefusal('graph', [])).toBe('the seed placed no mailbox sources');
  });

  it('accepts every source on its own path', () => {
    expect(mailPathRefusal('gmail-replay', googleRows)).toBeNull();
    expect(mailPathRefusal('graph', graphRows)).toBeNull();
  });
});
