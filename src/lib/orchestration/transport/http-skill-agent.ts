// HttpSkillAgent — a CapabilityAgent whose implementation lives across HTTP.
//
// The orchestration spine cannot tell this from an in-process agent: same
// input, same result, same report side-channel (replayed from the wire — see
// wire.ts). This is the adapter that makes the in-platform vs. separate-
// service architecture decision reversible: swapping where a skill runs is
// swapping this class for the local one, with zero spine changes.

import type { CapabilityAgent, AgentInput } from '../contract';
import type { AgentResult } from '../types';
import type { SkillWireRequest, SkillWireResponse } from './wire';

export type HttpSkillAgentOptions = {
  /** Registry id sent on the wire (e.g. 'target-universe'). */
  name: string;
  /** Skill-service endpoint to POST runs to. */
  url: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export class HttpSkillAgent<T = unknown> implements CapabilityAgent<T> {
  readonly name: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpSkillAgentOptions) {
    this.name = opts.name;
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async run(input: AgentInput): Promise<AgentResult<T>> {
    const request: SkillWireRequest = {
      skill: this.name,
      goal: input.goal,
      envelope: input.envelope,
      completionCondition: input.completionCondition,
      model: input.model,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (error) {
      return this.failed(input, `skill service unreachable: ${String(error)}`);
    }

    if (!response.ok) {
      return this.failed(input, `skill service returned ${response.status}`);
    }

    const wire = (await response.json()) as SkillWireResponse<T>;
    for (const entry of wire.reports) input.report(entry);

    return {
      result: wire.result,
      auditRecord: wire.auditRecord,
      status: wire.status,
      completionAssertion: wire.completionAssertion,
    };
  }

  private failed(input: AgentInput, reason: string): AgentResult<T> {
    return {
      result: undefined as T,
      auditRecord: {
        saw: [],
        did: 'Nothing: the HTTP dispatch failed before the skill ran.',
        why: reason,
        modelUsed: input.model,
        tokens: 0,
      },
      status: 'failed',
      completionAssertion: reason,
    };
  }
}
