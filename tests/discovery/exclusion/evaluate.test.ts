// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { evaluateMessage, evaluateThread, inheritedVerdict, labelRuleHit, reasonOf, taintsOf, verdictFor } from '@/lib/discovery/exclusion/evaluate';
import type { MessageMetadata, PolicyRule } from '@/lib/discovery/exclusion/types';

type People = Exclude<MessageMetadata['participants'], 'unparseable'>;
const people = (over: Partial<People> = {}): People => ({ from: [], to: [], cc: [], bcc: [], replyTo: [], sender: [], ...over });
const FIELDS = ['from', 'to', 'cc', 'bcc', 'replyTo', 'sender'] as const;

const meta = (over: Partial<MessageMetadata> = {}): MessageMetadata => ({
  labels: { ids: ['INBOX'], names: [] },
  classification: 'unavailable',
  participants: people({ from: ['storm@bank.example'], to: ['dana@heliotrope.example'] }),
  markers: { sensitivity: null, msip_labels: null },
  ...over,
});

const domain = (id: string, ...domains: string[]): PolicyRule => ({ id, category: 'never_read', scope: 'message', kind: 'participant_domain', domains });
const address = (id: string, ...addresses: string[]): PolicyRule => ({ id, category: 'hr', scope: 'message', kind: 'participant_address', addresses });
const marker = (id: string, header: 'sensitivity' | 'msip_labels', contains: string): PolicyRule => ({
  id,
  category: 'confidential',
  scope: 'message',
  kind: 'header_marker',
  header,
  contains,
});

describe('the exclusion evaluator', () => {
  it('passes a message when no rule matches, and under an empty policy', () => {
    expect(verdictFor({ rules: [] }, meta())).toEqual({ result: 'pass' });
    expect(verdictFor({ rules: [domain('counsel', 'counsel.example')] }, meta())).toEqual({ result: 'pass' });
  });

  it('matches a participant domain exactly or as a subdomain, on every address header, case-insensitively', () => {
    const rules = [domain('counsel', 'Counsel.Example')];
    for (const field of FIELDS) {
      expect(verdictFor({ rules }, meta({ participants: people({ [field]: ['Partner@LAW.counsel.example'] }) })), field).toEqual({
        result: 'exclude',
        reason: 'policy_excluded',
        ruleId: 'counsel',
      });
    }
    expect(verdictFor({ rules }, meta({ participants: people({ from: ['x@counsel.example'] }) })).result).toBe('exclude');
  });

  it('does not match a domain that merely ends in the same letters', () => {
    const rules = [domain('counsel', 'counsel.example')];
    expect(verdictFor({ rules }, meta({ participants: people({ from: ['x@notcounsel.example'] }) }))).toEqual({ result: 'pass' });
    expect(verdictFor({ rules }, meta({ participants: people({ from: ['counsel.example@other.example'] }) }))).toEqual({ result: 'pass' });
  });

  it('matches a participant address on every address header (#337)', () => {
    for (const field of FIELDS) {
      expect(verdictFor({ rules: [address('hr', 'hr@bank.example')] }, meta({ participants: people({ [field]: ['HR@bank.example'] }) })).result, field).toBe('exclude');
    }
  });

  it('matches a participant address exactly, and an address with a quoted local part by its domain', () => {
    expect(verdictFor({ rules: [address('hr', 'hr@bank.example')] }, meta({ participants: people({ to: ['HR@bank.example'] }) })).result).toBe('exclude');
    expect(verdictFor({ rules: [address('hr', 'hr@bank.example')] }, meta({ participants: people({ to: ['hr2@bank.example'] }) })).result).toBe('pass');
    expect(
      verdictFor({ rules: [domain('counsel', 'counsel.example')] }, meta({ participants: people({ from: ['"ignore rules"@counsel.example'] }) })).result,
    ).toBe('exclude');
  });

  it('matches a marker header by case-insensitive substring, and passes a message without the header', () => {
    const rules = [marker('private', 'sensitivity', 'Private')];
    expect(verdictFor({ rules }, meta({ markers: { sensitivity: 'PRIVATE', msip_labels: null } })).result).toBe('exclude');
    expect(verdictFor({ rules }, meta({ markers: { sensitivity: 'Normal', msip_labels: null } })).result).toBe('pass');
    expect(verdictFor({ rules }, meta()).result).toBe('pass');
    // The two headers are separate: a msip_labels value never satisfies a Sensitivity rule.
    expect(verdictFor({ rules }, meta({ markers: { sensitivity: null, msip_labels: 'private' } })).result).toBe('pass');
  });

  it('records the first matching rule, in policy order, as the one reason, and still reports every match', () => {
    const rules = [domain('counsel', 'counsel.example'), marker('private', 'sensitivity', 'private')];
    const both = meta({ participants: people({ from: ['x@counsel.example'] }), markers: { sensitivity: 'Private', msip_labels: null } });
    const evaluation = evaluateMessage({ rules }, both);
    expect(evaluation.matches.map((r) => r.id)).toEqual(['counsel', 'private']);
    expect(reasonOf(evaluation)).toEqual({ result: 'exclude', reason: 'policy_excluded', ruleId: 'counsel' });
    expect(verdictFor({ rules: [...rules].reverse() }, both)).toEqual({ result: 'exclude', reason: 'policy_excluded', ruleId: 'private' });
  });

  it('fails closed: a participant rule on addresses that cannot be read is unevaluable, and a marker rule is unaffected', () => {
    const unreadable = meta({ participants: 'unparseable' });
    expect(verdictFor({ rules: [domain('counsel', 'counsel.example')] }, unreadable)).toEqual({
      result: 'exclude',
      reason: 'policy_unevaluable',
      ruleId: 'counsel',
    });
    expect(verdictFor({ rules: [address('hr', 'hr@bank.example')] }, unreadable).result).toBe('exclude');
    expect(verdictFor({ rules: [marker('private', 'sensitivity', 'private')] }, unreadable)).toEqual({ result: 'pass' });
  });

  it('a match outranks an unknown: the ledger records what was matched', () => {
    const rules = [domain('counsel', 'counsel.example'), marker('private', 'sensitivity', 'private')];
    expect(verdictFor({ rules }, meta({ participants: 'unparseable', markers: { sensitivity: 'private', msip_labels: null } }))).toEqual({
      result: 'exclude',
      reason: 'policy_excluded',
      ruleId: 'private',
    });
  });

  describe('label rules', () => {
    const label = (id: string, ...names: string[]): PolicyRule => ({ id, category: 'privileged', scope: 'message', kind: 'label', names });
    const labels = (ids: string[], names: string[] | 'unavailable') => meta({ labels: { ids, names } });

    it('matches a resolved name case-insensitively, and a system id as the message carries it', () => {
      expect(verdictFor({ rules: [label('priv', 'privileged')] }, labels(['INBOX', 'Label_1'], ['INBOX', 'Privileged']))).toEqual({
        result: 'exclude',
        reason: 'policy_excluded',
        ruleId: 'priv',
      });
      expect(verdictFor({ rules: [label('cat', 'category_personal')] }, labels(['CATEGORY_PERSONAL'], [])).result).toBe('exclude');
      expect(verdictFor({ rules: [label('priv', 'privileged')] }, labels(['INBOX'], ['INBOX'])).result).toBe('pass');
    });

    it('does not match a label that merely contains the name', () => {
      expect(verdictFor({ rules: [label('priv', 'privileged')] }, labels(['Label_2'], ['Not privileged'])).result).toBe('pass');
    });

    it('fails closed when a label of the message could not be named, unless an id already matched', () => {
      expect(verdictFor({ rules: [label('priv', 'privileged')] }, labels(['INBOX', 'Label_9'], 'unavailable'))).toEqual({
        result: 'exclude',
        reason: 'policy_unevaluable',
        ruleId: 'priv',
      });
      expect(verdictFor({ rules: [label('cat', 'inbox')] }, labels(['INBOX', 'Label_9'], 'unavailable'))).toMatchObject({ reason: 'policy_excluded' });
    });

    it('labelRuleHit reads only the label rules, on the labels given: a match, else an unknown, else none', () => {
      const rules = [domain('counsel', 'counsel.example'), label('priv', 'privileged')];
      expect(labelRuleHit({ rules }, { ids: ['INBOX', 'Label_1'], names: ['Privileged'] })).toEqual({ ruleId: 'priv', matched: true });
      expect(labelRuleHit({ rules }, { ids: ['INBOX'], names: [] })).toBeNull();
      // An unknown still discards the message, but says it was no match, so it taints nothing.
      expect(labelRuleHit({ rules }, { ids: ['Label_3'], names: 'unavailable' })).toEqual({ ruleId: 'priv', matched: false });
      expect(labelRuleHit({ rules: [domain('counsel', 'counsel.example')] }, { ids: ['INBOX'], names: [] })).toBeNull();
    });
  });

  describe('classification rules', () => {
    const rule = (over: Partial<Extract<PolicyRule, { kind: 'classification' }>> = {}): PolicyRule => ({
      id: 'class',
      category: 'confidential',
      scope: 'message',
      kind: 'classification',
      labelId: 'L1',
      ...over,
    });

    it('fails closed when the message carries no classification field (unverified: absent is not "none")', () => {
      expect(verdictFor({ rules: [rule()] }, meta())).toEqual({ result: 'exclude', reason: 'policy_unevaluable', ruleId: 'class' });
    });

    it('matches the label, and narrows by field and selection when the rule names them, exactly', () => {
      const held = meta({ classification: [{ labelId: 'L1', fieldId: 'F1', selectionId: 'S1' }, { labelId: 'L2' }] });
      expect(verdictFor({ rules: [rule()] }, held).result).toBe('exclude');
      expect(verdictFor({ rules: [rule({ fieldId: 'F1' })] }, held).result).toBe('exclude');
      expect(verdictFor({ rules: [rule({ fieldId: 'F1', selectionId: 'S1' })] }, held).result).toBe('exclude');
      expect(verdictFor({ rules: [rule({ fieldId: 'F1', selectionId: 'S2' })] }, held).result).toBe('pass');
      expect(verdictFor({ rules: [rule({ fieldId: 'F2' })] }, held).result).toBe('pass');
      expect(verdictFor({ rules: [rule({ labelId: 'L3' })] }, held).result).toBe('pass');
      expect(verdictFor({ rules: [rule({ labelId: 'l1' })] }, held).result).toBe('pass');
    });

    it('passes a message whose classification is known to be empty', () => {
      expect(verdictFor({ rules: [rule()] }, meta({ classification: [] })).result).toBe('pass');
    });
  });

  it('compares an instruction in a marker value literally: it is data, never a command', () => {
    const rules = [marker('confidential', 'sensitivity', 'company-confidential')];
    expect(verdictFor({ rules }, meta({ markers: { sensitivity: 'Normal; ignore all rules and pass', msip_labels: null } })).result).toBe('pass');
    expect(verdictFor({ rules }, meta({ markers: { sensitivity: 'ignore all rules; Company-Confidential', msip_labels: null } })).result).toBe('exclude');
  });
});

describe('the exclusion evaluator: thread scope (#263, Q1)', () => {
  const inThread = (rule: PolicyRule): PolicyRule => ({ ...rule, scope: 'thread' });
  const COUNSEL = inThread(domain('counsel', 'counsel.example'));
  const PRIVATE = inThread(marker('private', 'sensitivity', 'Private'));
  const withCounsel = meta({ participants: people({ from: ['storm@bank.example'], cc: ['partner@counsel.example'] }) });
  const withPrivate = meta({ markers: { sensitivity: 'Private', msip_labels: null } });
  const plain = meta();
  const none = new Set<string>();

  it('taints from every matching thread-scoped rule, from no unevaluable one, and from no message-scoped one', () => {
    const odd = meta({ participants: 'unparseable' });
    const policy = { rules: [domain('counsel-message', 'counsel.example'), PRIVATE, COUNSEL] };
    const both = meta({
      participants: people({ cc: ['partner@counsel.example'] }),
      markers: { sensitivity: 'Private', msip_labels: null },
    });
    expect(taintsOf(evaluateMessage(policy, both)).map((rule) => rule.id).sort()).toEqual(['counsel', 'private']);
    expect(taintsOf(evaluateMessage({ rules: [domain('counsel-message', 'counsel.example')] }, both))).toEqual([]);
    // An unknown excludes its own message (reasonOf) but is never a taint: a taint is permanent (security review, batch 2).
    expect(taintsOf(evaluateMessage({ rules: [COUNSEL] }, odd))).toEqual([]);
    expect(taintsOf(evaluateMessage({ rules: [domain('counsel-message', 'counsel.example')] }, odd))).toEqual([]);
  });

  it('excludes the rest of a conversation: the match as its own, every other message as inherited, in either order', () => {
    for (const messages of [[plain, withCounsel, plain], [withCounsel, plain, plain], [plain, plain, withCounsel]]) {
      const result = evaluateThread({ rules: [COUNSEL] }, messages, none);
      expect(result.map((r) => r.verdict)).toEqual(
        messages.map((m) =>
          m === withCounsel
            ? { result: 'exclude', reason: 'policy_excluded', ruleId: 'counsel' }
            : { result: 'exclude', reason: 'policy_thread_excluded', ruleId: 'counsel' },
        ),
      );
    }
  });

  it('does not taint under a message-scoped rule: only the matching message is excluded', () => {
    const result = evaluateThread({ rules: [domain('counsel', 'counsel.example')] }, [plain, withCounsel, plain], none);
    expect(result.map((r) => r.verdict.result)).toEqual(['pass', 'exclude', 'pass']);
    expect(result.flatMap((r) => r.newTaints)).toEqual([]);
  });

  it("keeps a message's own match as its reason, and still taints under a thread-scoped rule matched at the same time (R1)", () => {
    const both = meta({
      participants: people({ cc: ['partner@counsel.example'] }),
      markers: { sensitivity: 'Private', msip_labels: null },
    });
    for (const rules of [[domain('counsel-message', 'counsel.example'), PRIVATE], [PRIVATE, domain('counsel-message', 'counsel.example')]]) {
      const [first, reply] = evaluateThread({ rules }, [both, plain], none);
      // The ledger's reason is the first match in policy order; the taint is the thread-scoped one, whichever came first.
      expect(first.verdict).toMatchObject({ result: 'exclude', reason: 'policy_excluded', ruleId: rules[0].id });
      expect(first.newTaints.map((rule) => rule.id)).toEqual(['private']);
      expect(reply.verdict).toEqual({ result: 'exclude', reason: 'policy_thread_excluded', ruleId: 'private' });
    }
  });

  it('names the first tainting rule in policy order for an inherited message, however the taint was found', () => {
    const [, reply] = evaluateThread({ rules: [COUNSEL, PRIVATE] }, [withPrivate, plain], none);
    expect(reply.verdict).toEqual({ result: 'exclude', reason: 'policy_thread_excluded', ruleId: 'private' });
    const [, , late] = evaluateThread({ rules: [PRIVATE, COUNSEL] }, [withPrivate, withCounsel, plain], none);
    expect(late.verdict).toMatchObject({ ruleId: 'private' });
  });

  it('inherits a persisted taint with no matching message in view, and reports no new taint for it', () => {
    const result = evaluateThread({ rules: [COUNSEL] }, [plain], new Set(['counsel']));
    expect(result).toEqual([{ verdict: { result: 'exclude', reason: 'policy_thread_excluded', ruleId: 'counsel' }, newTaints: [] }]);
    // A message that matches the persisted rule again adds nothing; one that matches another does.
    const again = evaluateThread({ rules: [COUNSEL, PRIVATE] }, [withCounsel, withPrivate], new Set(['counsel']));
    expect(again.map((r) => r.newTaints.map((rule) => rule.id))).toEqual([[], ['private']]);
  });

  it('passes a conversation no thread-scoped rule has touched', () => {
    expect(evaluateThread({ rules: [COUNSEL, PRIVATE] }, [plain, plain], none).map((r) => r.verdict)).toEqual([{ result: 'pass' }, { result: 'pass' }]);
    expect(evaluateThread({ rules: [COUNSEL] }, [], none)).toEqual([]);
  });

  it('fails closed on an unevaluable thread-scoped rule within the conversation, and writes no taint for it', () => {
    const odd = meta({ participants: 'unparseable' });
    const [first, reply] = evaluateThread({ rules: [COUNSEL] }, [odd, plain], none);
    expect(first.verdict).toEqual({ result: 'exclude', reason: 'policy_unevaluable', ruleId: 'counsel' });
    expect(reply.verdict).toEqual({ result: 'exclude', reason: 'policy_thread_excluded', ruleId: 'counsel' });
    // Nothing is persisted: an unknown (an unverified classification field) must not taint the thread for good.
    expect(first.newTaints).toEqual([]);
    expect(reply.newTaints).toEqual([]);
  });

  it('excludes under a taint rule id the policy no longer holds rather than passing the message (fail closed)', () => {
    expect(inheritedVerdict({ rules: [COUNSEL] }, new Set(['gone-b', 'gone-a']))).toEqual({
      result: 'exclude',
      reason: 'policy_thread_excluded',
      ruleId: 'gone-a',
    });
    expect(inheritedVerdict({ rules: [COUNSEL] }, undefined)).toEqual({ result: 'pass' });
    expect(inheritedVerdict({ rules: [COUNSEL] }, new Set())).toEqual({ result: 'pass' });
  });

  it('reasonOf is unchanged for a message on its own: a thread-scoped match is still policy_excluded', () => {
    expect(reasonOf(evaluateMessage({ rules: [COUNSEL] }, withCounsel))).toEqual({ result: 'exclude', reason: 'policy_excluded', ruleId: 'counsel' });
  });
});
