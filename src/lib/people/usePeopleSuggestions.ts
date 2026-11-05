'use client';

import * as React from 'react';

import { PERSON_SEARCH_SCOPE, type PersonSearchScope, type PersonSuggestion } from '@/lib/people/types';

const DEBOUNCE_MS = 200;

export type UsePeopleSuggestionsOptions = {
  query: string;
  dealId?: string | null;
  companyId?: string | null;
  scope?: PersonSearchScope;
  enabled?: boolean;
};

export function usePeopleSuggestions({
  query,
  dealId,
  companyId,
  scope,
  enabled = true,
}: UsePeopleSuggestionsOptions) {
  const [suggestions, setSuggestions] = React.useState<PersonSuggestion[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const trimmed = query.trim();
    const listAllEmployees =
      scope === PERSON_SEARCH_SCOPE.COMPANY_EMPLOYEES && enabled && trimmed.length === 0;
    if (!enabled || (!listAllEmployees && trimmed.length < 2)) {
      queueMicrotask(() => {
        setSuggestions([]);
        setLoading(false);
      });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      // The typed text rides in the POST body, never the URL (#331).
      const payload: Record<string, string> = {};
      if (trimmed) payload.query = trimmed;
      if (dealId) payload.dealId = dealId;
      if (companyId) payload.companyId = companyId;
      if (scope) payload.scope = scope;

      void (async () => {
        try {
          const res = await fetch('/api/v1/people/search', {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(String(res.status));
          const body = (await res.json()) as { people?: PersonSuggestion[] };
          if (!cancelled) setSuggestions(body.people ?? []);
        } catch {
          if (!cancelled) setSuggestions([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, dealId, companyId, scope, enabled]);

  return { suggestions, loading };
}
