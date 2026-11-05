// The requester the demo exclusion policy's audit row names. Its own module, free of import.meta, so the Playwright
// journey (compiled to CommonJS) can import it without loading demoPolicy.ts.

/** The seed, never a person (a synthetic tenant on a local stack). */
export const DEMO_POLICY_REQUESTED_BY = 'demo-seed';
