import { isProductionAppEnv } from '@/lib/appEnv';
import { READER_MODE, type ReaderMode } from '@/lib/constants/discovery';

/**
 * The reader mode for every provider (#259 R4, C12). There is no default: a
 * worker started without it must not guess, because the fixture would write
 * synthetic mail into a real tenant. The fixture is refused in production.
 * GRAPH_READER_PROVIDER and the value `graph` stay as aliases for one release.
 * No reader is imported here, so any script or worker may call it.
 */
export function readerModeFromEnv(env: Record<string, string | undefined> = process.env): ReaderMode {
  const raw = (env.DISCOVERY_READER_MODE ?? env.GRAPH_READER_PROVIDER)?.trim();
  if (raw === READER_MODE.FIXTURE) {
    if (isProductionAppEnv(env)) throw new Error('DISCOVERY_READER_MODE=fixture is refused in production');
    return READER_MODE.FIXTURE;
  }
  if (raw === READER_MODE.LIVE || raw === READER_MODE.GRAPH) return READER_MODE.LIVE;
  throw new Error('DISCOVERY_READER_MODE must be set to "fixture" or "live"');
}
