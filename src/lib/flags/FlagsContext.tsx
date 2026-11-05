'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { FlagKey } from './keys';
import type { FlagMap } from './resolveFlags';

// Holds the server-resolved flag snapshot for client components. null = no
// provider mounted, which useFlag treats as fail-closed (every flag false).
const FlagsContext = createContext<FlagMap | null>(null);

export function FlagsProvider({
  value,
  children,
}: {
  value: FlagMap;
  children: ReactNode;
}) {
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}

// Read a flag in a client component. Fail-closed: missing provider or missing key
// resolves to false (ADR-0007).
export function useFlag(key: FlagKey): boolean {
  const flags = useContext(FlagsContext);
  return flags?.[key] ?? false;
}
