import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCrmLeadsHref,
  crmLeadsHrefForNetworkNode,
  crmPersonFocusId,
  parseCrmLeadsFocus,
  pushCrmFocus,
} from '@/lib/leads/crmLeadsNavigation';
import { getCrmFocusSnapshot, publishCrmFocus } from '@/lib/leads/crmFocusStore';

/** Parse an href the way the page does: search from the URL, person from the fragment. */
function parseHref(href: string) {
  const url = new URL(href, 'http://localhost');
  return parseCrmLeadsFocus(url.searchParams, url.hash);
}

afterEach(() => {
  publishCrmFocus(undefined);
});

describe('crmLeadsNavigation', () => {
  it('builds and parses focus, with the person in the fragment', () => {
    const href = buildCrmLeadsHref({
      tab: 'companies',
      leadId: 'lead-figma',
      personName: 'Dylan Field',
    });
    expect(href).toBe('/leads?tab=companies&lead=lead-figma#person=Dylan+Field');
    expect(href).not.toContain('?person=');
    expect(href).not.toContain('&person=');

    expect(parseHref(href)).toEqual({
      tab: 'companies',
      leadId: 'lead-figma',
      personName: 'Dylan Field',
    });
  });

  it('keeps the person out of the query string, so nothing typed reaches a server log', () => {
    const url = new URL(buildCrmLeadsHref({ leadId: 'abc', personName: 'Jamie Rivera' }), 'http://localhost');
    expect(url.search).toBe('?lead=abc');
    expect(url.hash).toBe('#person=Jamie+Rivera');
  });

  it('round-trips names with reserved characters', () => {
    const name = 'Smith & Sons, #1 100% +Partners';
    const href = buildCrmLeadsHref({ leadId: 'abc', personName: name });
    expect(parseHref(href).personName).toBe(name);
    // Exactly one fragment: the name cannot smuggle a second parameter or a query.
    expect(new URL(href, 'http://localhost').search).toBe('?lead=abc');
  });

  it('omits the fragment when there is no person', () => {
    expect(buildCrmLeadsHref({ tab: 'companies', leadId: 'abc' })).toBe('/leads?tab=companies&lead=abc');
    expect(buildCrmLeadsHref({})).toBe('/leads');
  });

  it('defaults tab to companies when only lead is provided', () => {
    const focus = parseCrmLeadsFocus(new URLSearchParams('lead=abc'), '#person=Jamie');
    expect(focus.tab).toBe('companies');
    expect(focus.leadId).toBe('abc');
    expect(focus.personName).toBe('Jamie');
  });

  it('reads no person from the query string or from an absent fragment', () => {
    expect(parseCrmLeadsFocus(new URLSearchParams('lead=abc&person=Jamie')).personName).toBeUndefined();
    expect(parseCrmLeadsFocus(new URLSearchParams('lead=abc'), '').personName).toBeUndefined();
    expect(parseCrmLeadsFocus(new URLSearchParams('lead=abc'), '#other=1').personName).toBeUndefined();
  });

  it('builds network node navigation hrefs', () => {
    expect(crmLeadsHrefForNetworkNode('lead-figma', 'Mike Cannon-Brookes')).toBe(
      '/leads?tab=companies&lead=lead-figma#person=Mike+Cannon-Brookes',
    );
  });

  it('creates stable focus ids for person rows', () => {
    expect(crmPersonFocusId('Dylan Field')).toBe('crm-focus-dylan-field');
  });
});

describe('pushCrmFocus', () => {
  it('pushes the href and then publishes the person to the focus store', () => {
    const order: string[] = [];
    const router = {
      push: vi.fn((href: string) => {
        order.push(`push:${href}`);
      }),
    };
    const href = crmLeadsHrefForNetworkNode('lead-1', 'Ada Lovelace');
    pushCrmFocus(router, href, 'Ada Lovelace');

    expect(router.push).toHaveBeenCalledWith('/leads?tab=companies&lead=lead-1#person=Ada+Lovelace');
    expect(order).toEqual(['push:/leads?tab=companies&lead=lead-1#person=Ada+Lovelace']);
    expect(getCrmFocusSnapshot()).toBe('Ada Lovelace');
  });

  it('clears the focus when a company node is opened without a person', () => {
    publishCrmFocus('Ada Lovelace');
    const router = { push: vi.fn() };
    pushCrmFocus(router, buildCrmLeadsHref({ tab: 'companies', leadId: 'lead-1' }), undefined);
    expect(router.push).toHaveBeenCalledWith('/leads?tab=companies&lead=lead-1');
    expect(getCrmFocusSnapshot()).toBeUndefined();
  });
});
