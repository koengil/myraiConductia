'use client';

/**
 * AskComposer — the Composer wired to the one submit handler the platform has
 * for a question: push into the deal's /chat with the question in the URL
 * fragment (#q=), which never reaches a server or its logs (#331).
 * Every surface that offers "ask" mounts THIS (chat home, deal home), so the
 * wiring and the voice of the prompt are single-sourced, never forked.
 */

import { useRouter } from 'next/navigation';

import { Composer } from '@/components/workspace/Composer';
import { fragmentHref } from '@/lib/util/fragment';

export type AskComposerProps = {
  projectId: string;
  codename: string;
  placeholder?: string;
};

export function AskComposer({ projectId, codename, placeholder }: AskComposerProps) {
  const router = useRouter();

  function startChat(text: string) {
    router.push(`/projects/${projectId}/chat${fragmentHref('q', text)}`);
  }

  return (
    <Composer
      codename={codename}
      placeholder={placeholder ?? `Ask anything about ${codename}…`}
      onSubmit={startChat}
    />
  );
}
