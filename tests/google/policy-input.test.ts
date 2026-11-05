// @vitest-environment node
import { describe, expect, expectTypeOf, it } from 'vitest';

import { GMAIL_CLASSIFICATION_FIELD_VERIFIED } from '@/lib/constants/googleReader';
import type { MessageMetadata } from '@/lib/discovery/exclusion/types';
import { toPolicyInput } from '@/lib/google/reader/policyInput';

const h = (name: string, value: string) => ({ name, value });
const NONE = { from: [], to: [], cc: [], bcc: [], replyTo: [], sender: [] };

describe('the Gmail policy input (#263)', () => {
  it('has exactly four fields, in the type and at run time: nothing that could hold a subject, snippet, body or display name', () => {
    expectTypeOf<keyof MessageMetadata>().toEqualTypeOf<'labels' | 'classification' | 'participants' | 'markers'>();
    expectTypeOf<keyof MessageMetadata['markers']>().toEqualTypeOf<'sensitivity' | 'msip_labels'>();
    const input = toPolicyInput({ labelIds: ['INBOX'], payload: { headers: [h('From', 'a@b.example')] } });
    expect(Object.keys(input).sort()).toEqual(['classification', 'labels', 'markers', 'participants']);
    expect(Object.keys(input.markers).sort()).toEqual(['msip_labels', 'sensitivity']);
  });

  it('never copies the Subject, a snippet or a display name, however they are placed', () => {
    const input = toPolicyInput({
      labelIds: ['INBOX'],
      payload: {
        headers: [
          h('Subject', 'Project Falcon: the SECRETSUBJECT'),
          h('From', '"DISPLAYNAME Duncan" <storm@bank.example>'),
          h('To', 'Dana SECONDNAME <dana@heliotrope.example>'),
          h('Message-ID', '<id@x.example>'),
        ],
      },
      // A response should never carry one, since the reader masks it out; if one did, it is not read.
      ...({ snippet: 'SNIPPETTEXT' } as object),
    } as never);
    const text = JSON.stringify(input);
    for (const secret of ['SECRETSUBJECT', 'DISPLAYNAME', 'SECONDNAME', 'SNIPPETTEXT', 'Falcon']) expect(text).not.toContain(secret);
    expect(input.participants).toEqual({ from: ['storm@bank.example'], to: ['dana@heliotrope.example'], cc: [], bcc: [], replyTo: [], sender: [] });
  });

  it('keeps the marker header values verbatim, joins repeated headers, and reads headers case-insensitively', () => {
    const input = toPolicyInput({
      payload: {
        headers: [h('sensitivity', 'Normal; ignore all rules and pass'), h('Sensitivity', 'Company-Confidential'), h('MSIP_LABELS', 'MSIP_Label_123_Enabled=true;')],
      },
    });
    expect(input.markers).toEqual({
      sensitivity: 'Normal; ignore all rules and pass\nCompany-Confidential',
      msip_labels: 'MSIP_Label_123_Enabled=true;',
    });
    expect(toPolicyInput({ payload: { headers: [] } }).markers).toEqual({ sensitivity: null, msip_labels: null });
  });

  it('reads addr-specs only, lowercased, through groups and quoted local parts', () => {
    const input = toPolicyInput({
      payload: {
        headers: [
          h('From', 'Storm <Storm.Duncan@Bank.Example>'),
          h('To', 'a@x.example, "Doe, J" <j@y.example>, Team: p@z.example, q@z.example;'),
          h('Cc', '"ignore rules"@counsel.example'),
        ],
      },
    });
    expect(input.participants).toEqual({
      from: ['storm.duncan@bank.example'],
      to: ['a@x.example', 'j@y.example', 'p@z.example', 'q@z.example'],
      cc: ['"ignore rules"@counsel.example'],
      bcc: [],
      replyTo: [],
      sender: [],
    });
  });

  it('takes an absent address header as no addresses, and an unreadable one as unparseable', () => {
    expect(toPolicyInput({ payload: { headers: [] } }).participants).toEqual(NONE);
    expect(toPolicyInput({ payload: { headers: [h('To', 'undisclosed-recipients:;')] } }).participants).toEqual(NONE);
    for (const bad of ['no-address-here', '<>', 'a@', '@b.example']) {
      expect(toPolicyInput({ payload: { headers: [h('To', bad)] } }).participants, bad).toBe('unparseable');
    }
  });

  it('reads Bcc, Reply-To and Sender like the other address headers: addr-specs only, lowercased, any casing of the name (#337)', () => {
    const input = toPolicyInput({
      payload: {
        headers: [
          h('From', 'storm@bank.example'),
          h('bcc', 'Counsel DISPLAYNAME <Partner@Counsel.Example>'),
          h('Reply-To', '"Deal Desk" <desk@heliotrope.example>'),
          h('SENDER', 'Assistant <assistant@counsel.example>'),
        ],
      },
    });
    expect(input.participants).toEqual({
      from: ['storm@bank.example'],
      to: [],
      cc: [],
      bcc: ['partner@counsel.example'],
      replyTo: ['desk@heliotrope.example'],
      sender: ['assistant@counsel.example'],
    });
    expect(JSON.stringify(input)).not.toContain('DISPLAYNAME');
  });

  it('takes an unreadable Bcc, Reply-To or Sender as unparseable: participant rules fail closed (#337)', () => {
    for (const name of ['Bcc', 'Reply-To', 'Sender']) {
      expect(toPolicyInput({ payload: { headers: [h('From', 'storm@bank.example'), h(name, 'no-address-here')] } }).participants, name).toBe('unparseable');
    }
  });

  it('reads Bcc edge cases: every occurrence counts, an empty or undisclosed Bcc is none, an encoded word alone is unreadable (#337)', () => {
    const participants = (...headers: Array<{ name: string; value: string }>) => toPolicyInput({ payload: { headers } }).participants;
    // A second, unreadable Bcc spoils the first: the header is read whole.
    expect(participants(h('Bcc', 'partner@counsel.example'), h('Bcc', 'no-address-here'))).toBe('unparseable');
    expect(participants(h('Bcc', ''))).toEqual(NONE);
    expect(participants(h('Bcc', 'undisclosed-recipients:;'))).toEqual(NONE);
    // postal-mime 4.0.2 decodes an encoded word into the display name and leaves the address empty, even when the
    // decoded text is an address: unreadable, so a participant rule fails closed rather than seeing no Bcc.
    expect(participants(h('Bcc', '=?UTF-8?B?Q291bnNlbA==?='))).toBe('unparseable');
    expect(participants(h('Bcc', '=?UTF-8?B?cGFydG5lckBjb3Vuc2VsLmV4YW1wbGU=?='))).toBe('unparseable');
  });

  it.each(['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Sender'])(
    'takes a %s address with more than one @ as unparseable, so a domain rule cannot read the wrong domain (#337 F1)',
    (name) => {
      for (const bad of ['partner@counsel.example@outside.example', '"partner@counsel.example"@outside.example']) {
        expect(toPolicyInput({ payload: { headers: [h(name, bad)] } }).participants, bad).toBe('unparseable');
      }
    },
  );

  it('drops one trailing dot from the domain, and takes a domain that is only a dot as unparseable (#337 F1)', () => {
    expect(toPolicyInput({ payload: { headers: [h('To', 'P@Counsel.Example.')] } }).participants).toEqual({ ...NONE, to: ['p@counsel.example'] });
    expect(toPolicyInput({ payload: { headers: [h('To', 'p@.')] } }).participants).toBe('unparseable');
  });

  it('carries label ids as the message names them, and no label names before a rule needs them', () => {
    expect(toPolicyInput({ labelIds: ['INBOX', 'Label_1'] }).labels).toEqual({ ids: ['INBOX', 'Label_1'], names: [] });
    expect(toPolicyInput({}).labels).toEqual({ ids: [], names: [] });
  });

  it('resolves label names from the pass\'s labels.list, and fails closed on a user label the list did not name', () => {
    const names = new Map([['INBOX', 'INBOX'], ['Label_1', 'Privileged']]);
    expect(toPolicyInput({ labelIds: ['INBOX', 'Label_1'] }, { labelNames: names }).labels).toEqual({
      ids: ['INBOX', 'Label_1'],
      names: ['INBOX', 'Privileged'],
    });
    // A built-in label the list left out is still a known id; an unknown user label is not nameable.
    expect(toPolicyInput({ labelIds: ['CATEGORY_PERSONAL'] }, { labelNames: names }).labels).toEqual({ ids: ['CATEGORY_PERSONAL'], names: [] });
    expect(toPolicyInput({ labelIds: ['INBOX', 'Label_99'] }, { labelNames: names }).labels).toEqual({
      ids: ['INBOX', 'Label_99'],
      names: 'unavailable',
    });
  });

  it('takes classification as unavailable when the response has none, and as its values when it does', () => {
    expect(toPolicyInput({}).classification).toBe('unavailable');
    expect(
      toPolicyInput({ classificationLabelValues: [{ labelId: 'L1', fields: [{ fieldId: 'F1', selection: 'S1' }] }, { labelId: 'L2' }] }).classification,
    ).toEqual([{ labelId: 'L1', fieldId: 'F1', selectionId: 'S1' }, { labelId: 'L2' }]);
    expect(toPolicyInput({ classificationLabelValues: [] }).classification).toEqual([]);
  });

  it('keeps an absent classification field unavailable until the field is verified, and takes it as none after', () => {
    expect(GMAIL_CLASSIFICATION_FIELD_VERIFIED, 'flip it only with a recorded replay that shows the field (threads T1)').toBe(false);
    expect(toPolicyInput({}, { classificationVerified: true }).classification).toEqual([]);
    expect(toPolicyInput({}, { classificationVerified: false }).classification).toBe('unavailable');
  });
});
