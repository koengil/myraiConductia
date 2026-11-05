// The one reading of NEXT_PUBLIC_APP_ENV for production gates (#344): trimmed and
// lower-cased, with `prod` and `production` both counting, as the #339 model gate
// reads it. A stray space or capital must never switch a production refusal off.
// No imports, so any reader, script or worker module may use it.

type Env = Record<string, string | undefined>;

export function isProductionAppEnv(env: Env = process.env): boolean {
  const appEnv = env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  return appEnv === 'prod' || appEnv === 'production';
}
