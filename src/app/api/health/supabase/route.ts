import {
  getMissingSupabaseEnvVars,
  getSupabaseConfig,
  isSupabaseConfigured,
} from '@/lib/supabase/config';
import { checkSupabaseAuthHealth, checkSupabaseSecretHealth } from '@/lib/supabase/health';
import { gatewayKeyConfigured, warnOnce } from '@/lib/modelGateway/gatewayClient';

export async function GET() {
  if (!isSupabaseConfigured()) {
    return Response.json(
      {
        ok: false,
        configured: false,
        missing: getMissingSupabaseEnvVars(),
      },
      { status: 503 },
    );
  }

  const config = getSupabaseConfig()!;
  const [auth, admin] = await Promise.all([
    checkSupabaseAuthHealth(),
    checkSupabaseSecretHealth(),
  ]);
  const appEnv = config.environment;
  // Production must screen with the model (#505-2): without the gateway key it is not ready.
  // Dev and preview keep the rules-only fallback and its warning.
  const aiGatewayKeyConfigured = gatewayKeyConfigured();
  const aiReady = appEnv !== 'prod' || aiGatewayKeyConfigured;
  if (!aiReady) warnOnce('readiness', 'AI_GATEWAY_API_KEY is missing in prod: readiness fails until it is set');
  const ok = auth.ok && aiReady;

  if (appEnv === 'prod' || appEnv === 'staging') {
    return Response.json({ ok }, { status: ok ? 200 : 503 });
  }

  return Response.json(
    {
      ok,
      configured: true,
      environment: config.environment,
      projectUrl: config.url,
      checks: {
        auth,
        admin,
      },
      aiGatewayKeyConfigured,
      secretKeyConfigured: Boolean(config.secretKey),
      secretKeyValid: admin.ok,
    },
    { status: ok ? 200 : 503 },
  );
}
