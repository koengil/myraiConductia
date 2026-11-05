import type { FlagKey } from './keys';

// A FlagSource yields the stored ENABLED value for a flag, or null when the flag
// has no row in the backing store. Decoupling the read from any concrete backend
// keeps `isEnabled` pure and testable: the Supabase adapter is one implementation
// (server-side, service-role), tests use an in-memory fake.
export interface FlagSource {
  getEnabled(key: FlagKey): Promise<boolean | null>;
}
