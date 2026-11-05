import { BoxStorage } from './box';
import { LocalStorage } from './local';
import type { DataRoomStorage, StorageProviderName } from './types';

export type { DataRoomStorage, StoredObject, StorageProviderName } from './types';

export function resolveStorageProvider(
  env: NodeJS.ProcessEnv = process.env,
): StorageProviderName {
  const raw = env.STORAGE_PROVIDER?.toLowerCase();
  if (raw === 'box') return 'box';
  // Default local: dev/CI must work without Box credentials (spec c.15).
  return 'local';
}

let instance: DataRoomStorage | null = null;

export function getDataRoomStorage(): DataRoomStorage {
  if (!instance) {
    instance = resolveStorageProvider() === 'box' ? new BoxStorage() : new LocalStorage();
  }
  return instance;
}

/** Test seam. */
export function resetDataRoomStorage(): void {
  instance = null;
}
