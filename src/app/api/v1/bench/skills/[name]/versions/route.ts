import { NextResponse } from 'next/server';

import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { createSkillBench } from '@/lib/ignatious/bench';
import { readIgnatiousConfig } from '@/lib/ignatious/config';
import { SKILL_SERVICE_UNCONFIGURED_MESSAGE } from '@/lib/ignatious/failure';
import { ignatiousErrorResponse } from '@/lib/ignatious/routeContext';

type RouteContext = { params: Promise<{ name: string }> };

/** GET /api/v1/bench/skills/{name}/versions — history for the skills library. */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const config = readIgnatiousConfig();
  if (!config) {
    return jsonError(SKILL_SERVICE_UNCONFIGURED_MESSAGE, 503);
  }

  const { name } = await context.params;
  if (!name.trim()) return jsonError('Skill name is required', 400);

  try {
    const listed = await createSkillBench(config).listVersions(name);
    return NextResponse.json(listed);
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
