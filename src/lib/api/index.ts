import type { ConductiaAPI } from './types';
import { MockConductiaAPI } from './mock';

let _api: ConductiaAPI | null = null;
export function getApi(): ConductiaAPI {
  return (_api ??= new MockConductiaAPI());
}
