import { NextResponse } from 'next/server';

import { createSkillBench } from '@/lib/ignatious/bench';
import { ignatiousErrorResponse, requireIgnatiousCompany } from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ companyId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { companyId } = await context.params;
  const gate = await requireIgnatiousCompany(companyId);
  if (!gate.ok) return gate.response;

  try {
    const listed = await createSkillBench(gate.ctx.config).listSkills();
    return NextResponse.json({
      skills: listed.skills.filter((skill) => skill.status === 'ok'),
      defaultModel: listed.defaultModel,
    });
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
