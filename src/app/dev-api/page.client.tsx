'use client';

import 'swagger-ui-dist/swagger-ui.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { abortAllReads } from '@/lib/api/inflightRead';
import { clearLocalStores } from '@/lib/session/clearLocalStores';

// Which account you sign in as is a property of the database you point at, not
// of this page: the dev seed roster, the Conductia team roster and any account
// created through onboarding are all valid. The e-mail is therefore typed, and
// only the last one used is remembered.
const LAST_EMAIL_KEY = 'dev-api:last-email';

function SwaggerDoc() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const node = containerRef.current;

    // swagger-ui-dist is the vanilla bundle (no React wrapper), so it is
    // immune to the React 19 rendering issues that left swagger-ui-react's
    // operations spinning forever. Import client-side only.
    import('swagger-ui-dist').then(({ SwaggerUIBundle }) => {
      if (cancelled || !node) return;
      SwaggerUIBundle({
        url: '/api/v1/openapi.json',
        domNode: node,
        docExpansion: 'list',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
        requestInterceptor: (req) => {
          // Send the Supabase session cookie with Try-it-out requests.
          req.credentials = 'include';
          return req;
        },
      });
    });

    return () => {
      cancelled = true;
      if (node) node.innerHTML = '';
    };
  }, []);

  return <div ref={containerRef} />;
}

export default function DevApiPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supabase = useMemo(() => {
    try {
      return createSupabaseBrowserClient();
    } catch {
      return null;
    }
  }, []);

  // Restore what the browser already knows on mount: the last e-mail used, and
  // the Supabase session, which outlives a reload and keeps Try it out working
  // — so the strip should say who is signed in rather than look signed out.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [stored, signedIn] = await Promise.all([
        Promise.resolve(window.localStorage.getItem(LAST_EMAIL_KEY)),
        supabase?.auth.getUser().then(({ data }) => data.user?.email ?? null) ?? null,
      ]);
      if (cancelled) return;
      if (stored) setEmail(stored);
      if (signedIn) setSessionEmail(signedIn);
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const signIn = useCallback(async () => {
    if (!supabase) {
      setAuthError('Supabase is not configured (.env.local).');
      return;
    }
    setAuthError(null);
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setAuthError(error.message);
      setSessionEmail(null);
      return;
    }
    window.localStorage.setItem(LAST_EMAIL_KEY, email);
    setSessionEmail(data.user?.email ?? email);
  }, [email, password, supabase]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    // No read started as this user may deliver after the sign-out (#162).
    abortAllReads();
    await supabase.auth.signOut();
    clearLocalStores();
    setSessionEmail(null);
  }, [supabase]);

  return (
    <main className="h-dvh overflow-y-auto bg-[var(--surface-warm)]">
      <div className="border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--page-pad)] py-[var(--space-4)]">
        <div className="mx-auto flex max-w-5xl flex-col gap-[var(--space-3)]">
          <div className="flex items-baseline justify-between gap-[var(--space-4)]">
            <h1 className="text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
              Phase 1 API explorer
            </h1>
            <span className="font-mono text-[length:var(--text-xs)] tracking-[0.06em] text-[var(--ink-tertiary)]">
              Dev only
            </span>
          </div>
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            Sign in with any account on the database this app points at to set the session cookie,
            then use Try it out below. A freshly seeded account signs in with{' '}
            <code className="font-mono">SEED_PASSWORD</code> from{' '}
            <code className="font-mono">.env.local</code>.
          </p>

          <div className="flex flex-wrap items-end gap-[var(--space-3)]">
            <label className="flex flex-col gap-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              Account
              <input
                type="email"
                className="w-[18rem] rounded-[var(--radius-button)] border border-[var(--stroke)] bg-white px-[var(--space-3)] py-[var(--space-2)] font-mono text-[length:var(--text-sm)] text-[var(--ink)]"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@conductia.com"
                autoComplete="username"
                spellCheck={false}
              />
            </label>
            <label className="flex flex-col gap-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              Password
              <input
                type="password"
                className="rounded-[var(--radius-button)] border border-[var(--stroke)] bg-white px-[var(--space-3)] py-[var(--space-2)] font-mono text-[length:var(--text-sm)] text-[var(--ink)]"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="SEED_PASSWORD"
                autoComplete="current-password"
              />
            </label>
            <button
              type="button"
              className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] text-white disabled:opacity-50"
              disabled={busy || !email.trim() || !password}
              onClick={() => void signIn()}
            >
              Sign in
            </button>
            <button
              type="button"
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] disabled:opacity-50"
              disabled={busy || !sessionEmail}
              onClick={() => void signOut()}
            >
              Sign out
            </button>
            {sessionEmail ? (
              <span className="font-mono text-[length:var(--text-xs)] text-[var(--positive-deep)]">
                Signed in: {sessionEmail}
              </span>
            ) : null}
            {authError ? (
              <span className="font-mono text-[length:var(--text-xs)] text-[var(--status-blocked)]">
                {authError}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-[var(--page-pad)] py-[var(--space-4)]">
        <SwaggerDoc />
      </div>
    </main>
  );
}
