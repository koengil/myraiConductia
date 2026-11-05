import { NextResponse } from 'next/server';

import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { createSkillBench } from '@/lib/ignatious/bench';
import { readIgnatiousConfig } from '@/lib/ignatious/config';
import { SKILL_SERVICE_UNCONFIGURED_MESSAGE } from '@/lib/ignatious/failure';
import { ignatiousErrorResponse } from '@/lib/ignatious/routeContext';

/** GET /api/v1/bench/skills — catalog for the skills library (no lead required). */
export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const config = readIgnatiousConfig();
  if (!config) {
    return jsonError(SKILL_SERVICE_UNCONFIGURED_MESSAGE, 503);
  }

  try {
    const listed = await createSkillBench(config).listSkills();
    return NextResponse.json(listed);
  } catch (error) {
    return ignatiousErrorResponse(error);
  }
}
