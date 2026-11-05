import { createBoxClient } from './client';
import { createMockBoxClient } from './mock';
import { getBoxConfig, type BoxClient } from './types';

export type { BoxClient, BoxFile, BoxFolder, BoxConfig } from './types';
export { getBoxConfig, isBoxConfigured } from './types';
export {
  boxEnvironmentName,
  ensureBoxEnvironmentRootFolder,
  getBoxClientSecret,
} from './env';
export {
  boxSafeFileName,
  boxSafeName,
  BOX_EXTENSION_MAX_LENGTH,
  BOX_NAME_MAX_LENGTH,
} from './safeName';

let mockClient: BoxClient | null = null;

/** Real Box when configured; otherwise one process-wide mock so upload → list
 *  sees the same in-memory store across calls. */
export function getBoxClient(): BoxClient {
  const config = getBoxConfig();
  if (config) return createBoxClient(config);
  mockClient ??= createMockBoxClient();
  return mockClient;
}
