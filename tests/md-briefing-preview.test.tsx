/**
 * The md-briefing primary artifact gets an inline preview: fetched lazily on
 * <details> open, rendered on-dark, with the download link surviving in every
 * state and a 1 MB guard in front of the parser.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  ArtifactPreview,
  MAX_PREVIEW_BYTES,
  pickPreviewArtifact,
} from '@/components/rail/ArtifactPreview';
import { MdBriefingRunner } from '@/components/rail/MdBriefingRunner';
import { SessionProvider } from '@/lib/session/store';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const MEMO = '## MD brief\n\n| topic | read |\n|---|---|\n| price | firm |';

function artifact(over: Partial<{ path: string; kind: 'document' | 'structured'; primary: boolean; bytes: number }> = {}) {
  return { path: 'brief.md', kind: 'document' as const, primary: true, bytes: 51_000, ...over };
}

/**
 * Opens or closes a `<details>` by driving its native `open` state directly
 * and dispatching the `toggle` event, rather than clicking `<summary>`.
 * jsdom fires `toggle` on click, but only as a delayed task queued behind
 * the click (confirmed against jsdom directly) — a second synchronous click
 * in the same tick can race that queued event. Driving `.open` + dispatching
 * `toggle` synchronously sidesteps that timing entirely and keeps every
 * disclosure in this file behaving the same way.
 */
function setDisclosure(container: HTMLElement, open: boolean) {
  const details = container.querySelector('details');
  if (!details) throw new Error('no <details> in container');
  details.open = open;
  fireEvent(details, new Event('toggle'));
}

describe('pickPreviewArtifact', () => {
  it('picks the primary markdown document', () => {
    expect(pickPreviewArtifact([artifact()])?.path).toBe('brief.md');
  });

  it('ignores non-primary, structured, and non-markdown artifacts', () => {
    expect(
      pickPreviewArtifact([
        artifact({ path: 'notes.md', primary: false }),
        artifact({ path: 'data.json', kind: 'structured' }),
        artifact({ path: 'deck.pdf' }),
      ]),
    ).toBeNull();
  });

  it('accepts .markdown and .txt', () => {
    expect(pickPreviewArtifact([artifact({ path: 'brief.markdown' })])?.path).toBe('brief.markdown');
    expect(pickPreviewArtifact([artifact({ path: 'brief.txt' })])?.path).toBe('brief.txt');
  });
});

describe('ArtifactPreview', () => {
  it('does not fetch until the disclosure is opened, then renders markdown', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => MEMO }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifactIndex={0} artifact={artifact()} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    setDisclosure(container, true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expect(container.querySelector('h2')?.textContent).toBe('MD brief');
  });

  it('renders an alert on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    const { container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifactIndex={0} artifact={artifact()} />,
    );
    setDisclosure(container, true);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('renders an alert when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const { container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifactIndex={0} artifact={artifact()} />,
    );
    setDisclosure(container, true);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline'));
  });

  it('treats an empty body as no preview, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const { container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifactIndex={0} artifact={artifact()} />,
    );
    setDisclosure(container, true);
    await waitFor(() => expect(screen.queryByText(/Running|Loading/i)).toBeNull());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('skips the preview above the 1 MB guard and shows the size', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ArtifactPreview
        dealId="deal-1"
        executionId="exec-1"
        artifactIndex={0}
        artifact={artifact({ bytes: MAX_PREVIEW_BYTES + 1 })}
      />,
    );
    expect(screen.queryByText(/Preview/i)).toBeNull();
    expect(screen.getByText(/MB/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to render a body that exceeds the guard even when the declared size does not', async () => {
    const oversized = 'x'.repeat(MAX_PREVIEW_BYTES + 1);
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => oversized }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      // The declared size lies: 51 KB of metadata in front of a 1 MB body.
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifactIndex={0} artifact={artifact()} />,
    );
    setDisclosure(container, true);

    await waitFor(() => expect(screen.getByText(/MB/)).toBeTruthy());
    expect(screen.queryByText(/Preview/i)).toBeNull();
    expect(container.querySelector('table')).toBeNull();
  });

  // Invalidation is the host's job: MdBriefingRunner keys this component on
  // `${executionId}:${artifact.path}`, so a re-run mounts a fresh preview
  // rather than re-running an effect against a stale cache.
  it('fetches again when the host re-keys it on a new executionId', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => MEMO }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender, container } = render(
      <ArtifactPreview key="exec-1:brief.md" dealId="deal-1" executionId="exec-1" artifactIndex={0} artifact={artifact()} />,
    );
    setDisclosure(container, true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

    rerender(
      <ArtifactPreview key="exec-2:brief.md" dealId="deal-1" executionId="exec-2" artifactIndex={0} artifact={artifact()} />,
    );
    expect(container.querySelector('table')).toBeNull();

    setDisclosure(container, true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

// #331: the artifact is requested by its index in the run, never by its path.
describe('artifact requests carry an index, not a path (#331)', () => {
  it('previews through artifact=<n> with no path in the URL', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => MEMO }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifactIndex={3} artifact={artifact()} />,
    );
    setDisclosure(container, true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String((fetchMock.mock.calls as unknown[][])[0][0]);
    expect(url).toContain('executionId=exec-1');
    expect(url).toContain('artifact=3');
    expect(url).not.toMatch(/[?&]path=/);
    expect(url).not.toContain('brief.md');
  });

  it('links each artifact of a finished briefing by its index', async () => {
    const jsonResponse = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    const finished = {
      executionId: 'exec-1',
      runId: 'run-1',
      agentName: 'md-briefing',
      status: 'completed',
      outcome: 'ok',
      startedAt: null,
      finishedAt: null,
      dryRun: false,
      pendingQuestions: [],
      artifacts: [artifact(), artifact({ path: 'sources.json', kind: 'structured', primary: false, bytes: 40 })],
      filings: [],
      costUsd: null,
      durationMs: null,
      error: null,
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(404, { error: 'No run on this step' }))
        .mockResolvedValueOnce(jsonResponse(202, { executionId: 'exec-1', runId: 'run-1' }))
        .mockResolvedValue(jsonResponse(200, finished)),
    );
    render(
      <SessionProvider>
        <MdBriefingRunner dealId="ZZTES-2026-653" />
      </SessionProvider>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Draft the MD brief' }).click();
    });

    const first = (await screen.findByRole('link', { name: /brief\.md/ })).getAttribute('href') ?? '';
    const second = screen.getByRole('link', { name: /sources\.json/ }).getAttribute('href') ?? '';
    expect(first).toContain('executionId=exec-1');
    expect(first).toContain('artifact=0');
    expect(second).toContain('artifact=1');
    for (const href of [first, second]) {
      expect(href).not.toMatch(/[?&]path=/);
      expect(href).not.toContain('.md');
      expect(href).not.toContain('.json');
    }
  });
});
