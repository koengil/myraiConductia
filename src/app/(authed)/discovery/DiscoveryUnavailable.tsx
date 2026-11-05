/** What an external party sees on any /discovery route: Discovery is bank side only (#395). */
export function DiscoveryUnavailable() {
  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <div className="mx-auto max-w-[880px] px-6 py-10">
        <p className="eyebrow mb-1">Discovery</p>
        <h1 className="mb-1 text-[26px] font-semibold leading-tight tracking-[-0.012em] text-[var(--ink)]">
          Not available to your account
        </h1>
        <p role="status" className="text-[length:var(--text-md)] text-[var(--ink-tertiary)]">
          Discovery proposes deals from the bank&apos;s own mail and is open to the bank side only.
        </p>
      </div>
    </div>
  );
}
