// Tenant deal contacts are held for one pass; only the classification code is persisted.
export type DealContacts = { addresses: ReadonlySet<string>; domains: readonly string[] };
