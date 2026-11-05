// Dev-only stub of the remote skill service (feat/skill-execution-spike).
//
// Simulates the RTS-side service the platform would call in the separate-
// service architecture: it receives a SkillWireRequest (sealed envelope in),
// runs the named skill, and returns the SkillWireResponse (structured result
// + collected report entries out). Hosting it inside the app proves the wire
// contract without provisioning infrastructure; a real service implements the
// same two types and this route disappears.
//
// Deliberately unauthenticated but absent in production (404), mirroring the
// /dev-api precedent. A production skill service authenticates the platform,
// not the end user — the envelope is already permission-filtered upstream.

import { NextResponse } from 'next/server';
import { TargetUniverseAgent } from '@/lib/orchestration/agents/target-universe-agent';
import type { CapabilityAgent } from '@/lib/orchestration/contract';
import type { ComplianceMonitorEntry } from '@/lib/orchestration/types';
import type { SkillWireRequest, SkillWireResponse } from '@/lib/orchestration/transport/wire';

const SKILLS: Record<string, () => CapabilityAgent> = {
  'target-universe': () => new TargetUniverseAgent(),
};

export async function POST(request: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let wire: SkillWireRequest;
  try {
    wire = (await request.json()) as SkillWireRequest;
  } catch {
    return NextResponse.json({ error: 'Malformed body' }, { status: 400 });
  }
  if (!wire?.skill || !wire.envelope || !wire.model) {
    return NextResponse.json({ error: 'Malformed skill request' }, { status: 400 });
  }

  const factory = SKILLS[wire.skill];
  if (!factory) {
    return NextResponse.json({ error: `Unknown skill "${wire.skill}"` }, { status: 400 });
  }

  const reports: ComplianceMonitorEntry[] = [];
  const out = await factory().run({
    goal: wire.goal,
    envelope: wire.envelope,
    completionCondition: wire.completionCondition,
    model: wire.model,
    report: (entry) => reports.push(entry),
  });

  const body: SkillWireResponse = { ...out, reports };
  return NextResponse.json(body);
}
