// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * A lint over docs/04-operations/m365-sso-runbook.md (#316, cdt-m365-sso design
 * Q1, R1, R7, R8 and review round 2 M3 and minors 3 to 6). It catches an edit
 * that reorders the numbered steps, drops a STOP or rewrites its wording, loses
 * a precondition (version remedy, origin and redirect URLs, the recorded signup
 * setting, a Verified-domain mail address), shortens the teardown, brings back a
 * /v2.0 tenant URL, or lets a secret-shaped string or a claim value into the
 * page. It is not the control: it cannot stop an owner skipping a step.
 */

const root = process.cwd();
const runbookPath = join(root, 'docs/04-operations/m365-sso-runbook.md');
const contractPath = join(root, 'docs/03-engineering/work-identity-contract.md');
const bootstrapPath = join(root, 'docs/04-operations/production-bootstrap.md');
const decisionLogPath = join(root, 'docs/07-decisions/decision-log.md');

const runbook = readFileSync(runbookPath, 'utf8');
const contract = readFileSync(contractPath, 'utf8');
const bootstrap = readFileSync(bootstrapPath, 'utf8');
const decisionLog = readFileSync(decisionLogPath, 'utf8');

/** The fixed STOP wording (design Q1, review round 2 m4). */
const STOP_SENTENCE = 'Do not continue. If the flag is on, turn it off and go to Teardown.';

type Step = { number: number; title: string; body: string };

/** The numbered `## N. Title` steps, each with its text up to the next `## ` heading. */
function steps(text: string): Step[] {
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => ({ heading: m[1], index: m.index ?? 0 }));
  return headings.flatMap((h, i) => {
    const numbered = /^(\d+)\. (.+)$/.exec(h.heading);
    if (!numbered) return [];
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    return [{ number: Number(numbered[1]), title: numbered[2], body: text.slice(h.index, end) }];
  });
}

const all = steps(runbook);
const step = (number: number): Step => {
  const found = all.find((s) => s.number === number);
  if (!found) throw new Error(`step ${number} not found`);
  return found;
};
const numberOf = (pattern: RegExp): number => {
  const found = all.find((s) => pattern.test(s.title));
  if (!found) throw new Error(`no step title matches ${pattern}`);
  return found.number;
};

/** The fenced code blocks of `text` with the given language, in order. */
function fences(text: string, language: string): string[] {
  return [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);
}

/** Every shell command that begins with `prefix`, joined across its `\` continuation lines. */
function commands(text: string, prefix: string): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith(prefix)) continue;
    let command = lines[i].trim();
    while (command.endsWith('\\') && i + 1 < lines.length) {
      i += 1;
      command = `${command.slice(0, -1).trim()} ${lines[i].trim()}`;
    }
    found.push(command);
  }
  return found;
}

/** Relative markdown link targets (`](./x)` or `](../x)`), without any anchor. */
function relativeLinks(text: string): string[] {
  return [...text.matchAll(/\]\((\.{1,2}\/[^)\s#]+)(?:#[^)\s]*)?\)/g)].map((m) => m[1]);
}

describe('the numbered steps', () => {
  it('are 1 to 9, in order, with no gap', () => {
    expect(all.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('each end with a Verify: line', () => {
    for (const s of all) expect(s.body, `step ${s.number}`).toMatch(/^Verify: /m);
  });

  it('keeps the sections after the steps: next tenant and the evidence template', () => {
    expect(runbook).toMatch(/^## Next tenant \(Ignatious\)$/m);
    expect(runbook).toMatch(/^## Evidence record template$/m);
    expect(runbook.indexOf('## Next tenant')).toBeGreaterThan(runbook.indexOf('## 9. '));
  });
});

describe('the order (design Q1, R7)', () => {
  it('runs preconditions, hook gate, flag on, claims check, accept, teardown in that order', () => {
    const preconditions = numberOf(/^Preconditions/);
    const hook = numberOf(/^Hook gate/);
    const flag = numberOf(/^Flag on/);
    const claims = numberOf(/^Sign in, check claims/);
    const accept = numberOf(/^Accept/);
    const teardown = numberOf(/^Teardown/);
    expect([preconditions, hook, flag, claims, accept, teardown]).toEqual(
      [preconditions, hook, flag, claims, accept, teardown].slice().sort((a, b) => a - b),
    );
    expect(new Set([preconditions, hook, flag, claims, accept, teardown]).size).toBe(6);
    expect(numberOf(/^Register the Entra app/)).toBeLessThan(numberOf(/^Configure the dev Azure provider/));
    // Audit item 3: Supabase's OAuth endpoints do not read the app flag, so the
    // provider and signups go on only after the hook gate.
    expect(hook).toBeLessThan(numberOf(/^Configure the dev Azure provider/));
    expect(numberOf(/^Configure the dev Azure provider/)).toBeLessThan(flag);
    expect(accept).toBeLessThan(numberOf(/^Record the evidence/));
    expect(numberOf(/^Record the evidence/)).toBeLessThan(teardown);
  });

  it('turns the flag on only at the flag step', () => {
    const flag = numberOf(/^Flag on/);
    for (const s of all) {
      if (s.number === flag) continue;
      expect(s.body, `step ${s.number}`).not.toMatch(/set enabled = true where key = 'work_identity_onboarding'/);
    }
    expect(step(flag).body).toMatch(/set enabled = true where key = 'work_identity_onboarding'/);
  });

  it('returns the flag row when it turns the flag on and off, and stops on zero rows (audit item 7)', () => {
    expect(step(numberOf(/^Flag on/)).body).toContain(
      "update feature_flags set enabled = true where key = 'work_identity_onboarding' returning key, enabled;",
    );
    expect(step(numberOf(/^Flag on/)).body).toMatch(/Zero rows means the flag row does not exist[^\n]*Do not continue\./);
    expect(step(numberOf(/^Teardown/)).body).toContain(
      "update feature_flags set enabled = false where key = 'work_identity_onboarding' returning key, enabled;",
    );
  });

  it('never presses Accept before the claims check: the Accept instruction comes after the STOP', () => {
    const claims = step(numberOf(/^Sign in, check claims/)).body;
    expect(claims).toMatch(/Do not press Accept/);
    expect(step(numberOf(/^Accept/)).body).toMatch(/press Accept/);
  });
});

describe('the STOP steps (review round 2 m4)', () => {
  const stops = all.filter((s) => /\(STOP\)/.test(s.title));

  it('are preconditions, the hook gate and the claims check', () => {
    expect(stops.map((s) => s.number)).toEqual([numberOf(/^Preconditions/), numberOf(/^Hook gate/), numberOf(/^Sign in, check claims/)]);
  });

  it('each use the fixed wording: do not continue, turn the flag off, go to Teardown', () => {
    for (const s of stops) expect(s.body, `step ${s.number}`).toContain(STOP_SENTENCE);
  });

  it('never says the flag stays off', () => {
    expect(runbook).not.toMatch(/flag stays off/i);
  });

  it('states the fixed wording in the intro too, once as the rule', () => {
    expect(runbook.slice(0, runbook.indexOf('## 1. '))).toContain(STOP_SENTENCE);
  });

  it('says what good looks like and the remedy in every STOP step', () => {
    for (const s of stops) {
      expect(s.body, `step ${s.number}`).toMatch(/\bGood: /);
      expect(s.body, `step ${s.number}`).toMatch(/\bRemedy\b/i);
    }
  });
});

describe('preconditions (design R1, R7, review round 2 M3a and m6)', () => {
  const body = () => step(numberOf(/^Preconditions/)).body;

  it('checks the Auth version at v2.190.0 with a keyed health call, and gives a remedy', () => {
    expect(body()).toMatch(/v2\.190\.0/);
    expect(body()).toMatch(/curl -s -H "apikey: <dev publishable key>" https:\/\/<dev-ref>\.supabase\.co\/auth\/v1\/health/);
    expect(body()).toMatch(/Infrastructure/);
  });

  it('cannot be waived below the Auth floor: a note records why the proof did not run (audit item 4)', () => {
    expect(body()).toContain('This STOP cannot be waived');
    expect(body()).toMatch(/never lets it continue/);
    expect(runbook).not.toMatch(/pin not proven|proof then continues/i);
  });

  it('names both migrations, with a to_regprocedure fallback (audit item 7)', () => {
    expect(body()).toContain('20261002100000');
    expect(body()).toContain('20261010100000');
    expect(body()).toContain("to_regprocedure('public.work_identity_access_token_hook(jsonb)')");
    expect(body()).toContain("to_regprocedure('public.work_identity_has_unbound(uuid)')");
  });

  it('records the signup and URL settings and changes nothing (audit item 3)', () => {
    expect(body()).toMatch(/Record the signup setting and the URL settings\. Change nothing yet\./);
    expect(body()).toMatch(/Do not switch signups on here/);
    for (const field of ['disable_signup', 'site_url', 'uri_allow_list']) expect(body(), field).toContain(field);
  });

  it('turns signups on only in the provider step, after the hook gate (audit item 3)', () => {
    const provider = step(numberOf(/^Configure the dev Azure provider/));
    expect(provider.title).toMatch(/allow signups/);
    expect(provider.body).toMatch(/Only after the hook gate \(step 2\) passed/);
    expect(provider.body).toMatch(/switch "Allow new users to sign up" on/);
    for (const s of all) {
      if (s.number === provider.number) continue;
      expect(s.body, `step ${s.number}`).not.toMatch(/switch "Allow new users to sign up" on/);
    }
  });

  it('permits the develop origin only, never a preview (audit item 5)', () => {
    expect(body()).toMatch(/`<origin>` is the `develop` deployment's origin: it is the only origin permitted for this proof/);
    expect(runbook).toMatch(/\| `<origin>` \| The `develop` deployment's origin, the only app origin permitted for this proof\. Never a preview origin \|/);
    expect(runbook).not.toMatch(/another deployment|for example the `develop` deployment/);
  });

  it('names the app origin, Site URL, Redirect URLs and NEXT_PUBLIC_APP_URL', () => {
    for (const needle of ['Site URL', 'Redirect URLs', '<origin>/**', 'NEXT_PUBLIC_APP_URL']) expect(body(), needle).toContain(needle);
  });
});

describe('the Entra app step (review round 2 M3b, design R4, R11)', () => {
  const body = () => step(numberOf(/^Register the Entra app/)).body;

  it('is single tenant with assigned users and the callback redirect', () => {
    expect(body()).toMatch(/single tenant/i);
    expect(body()).toMatch(/Assignment required/);
    expect(body()).toContain('https://<dev-ref>.supabase.co/auth/v1/callback');
    expect(body()).toMatch(/2026-10-24/);
  });

  it('names the optional claims, the Verified domain and the mail address, not the UPN', () => {
    for (const needle of ['acct', 'xms_edov', 'email', 'Verified', 'not the UPN']) expect(body(), needle).toContain(needle);
  });

  it('never reuses the Graph reader app', () => {
    expect(body()).toMatch(/separate app/i);
  });
});

describe('the Azure provider step (design R8)', () => {
  it('writes the tenant URL without /v2.0 and turns "allow users without an email" off', () => {
    const body = step(numberOf(/^Configure the dev Azure provider/)).body;
    expect(body).toContain('https://login.microsoftonline.com/<tenant-id>');
    expect(body).toMatch(/without\*\* a `\/v2\.0` suffix/);
    expect(body).toMatch(/Allow users without an email\*\*: off/);
  });
});

describe('the hook gate (design Q1)', () => {
  it('checks the Management API fields and the grants, with the good values', () => {
    const body = step(numberOf(/^Hook gate/)).body;
    expect(body).toContain('hook_custom_access_token_enabled');
    expect(body).toContain('pg-functions://postgres/public/work_identity_access_token_hook');
    expect(body).toContain('auth_can_run');
    expect(body).toContain('browser_can_run');
    expect(body).toMatch(/`auth_can_run` true and `browser_can_run` false/);
  });
});

describe('the hook prior state (audit item 6)', () => {
  it('records the hook state and the external identity count before enabling it', () => {
    const body = step(numberOf(/^Hook gate/)).body;
    expect(body).toMatch(/Record first, before you enable anything/);
    expect(body).toContain("select provider, count(*) from auth.identities where provider not in ('email', 'phone') group by 1;");
    expect(body.indexOf('Record first')).toBeLessThan(body.indexOf('enable it in the dashboard'));
  });

  it('says in Teardown whether the hook stays on, and why, and the template has the rows', () => {
    expect(step(numberOf(/^Teardown/)).body).toMatch(/\*\*The hook stays on\.\*\* Proposed:/);
    expect(runbook).toContain('| Hook before the proof (step 2): enabled, URI | |');
    expect(runbook).toContain('| Non-email, non-phone identities on dev before the proof (step 2): provider, count | |');
    expect(runbook).toMatch(/\| Teardown \d+ hook: stays on \/ turned off, and why \| \|/);
  });
});

describe('the claim-shape query (design R6)', () => {
  const sql = () => {
    const block = fences(step(numberOf(/^Sign in, check claims/)).body, 'sql')[0];
    if (!block) throw new Error('no SQL block in the claims step');
    return block;
  };

  it('returns the four booleans and the key names and types', () => {
    for (const alias of ['tid_matches_firm', 'acct_member', 'xms_edov_true', 'email_present', 'custom_claim_keys', 'tid_type', 'acct_type', 'xms_edov_type']) {
      expect(sql(), alias).toMatch(new RegExp(`\\bas ${alias}\\b`));
    }
  });

  it('is read by the test firm company id, from a pending work-identity invite', () => {
    expect(sql()).toContain("v.company_id = '<test firm company id>'");
    expect(sql()).toMatch(/v\.status = 'pending'/);
    expect(sql()).toMatch(/auth_method = 'work_identity'/);
  });

  it('selects no claim value: no star, no raw identity_data column', () => {
    const select = sql().slice(0, sql().indexOf('\nfrom '));
    expect(select).not.toMatch(/\*/);
    expect(select).not.toMatch(/i\.identity_data\s*,/);
    expect(select).not.toMatch(/to_json|row_to_json|to_jsonb/);
    expect(select).not.toMatch(/as (email|tid|oid|sub|upn)\b/);
  });
});

describe('the accept step', () => {
  it('covers sign out and back in, the uninvited user, and the optional T1 window with its verified switch-back', () => {
    const body = step(numberOf(/^Accept/)).body;
    expect(body).toMatch(/Sign out/);
    expect(body).toContain('work_identity_not_connected');
    expect(body).toMatch(/T1/);
    expect(body).toMatch(/external_azure_url/);
    expect(body).toMatch(/switch both back in the same sitting/);
  });
});

describe('the teardown (design R7, review round 2 m3)', () => {
  const body = () => step(numberOf(/^Teardown/)).body;

  it('is same day', () => {
    expect(step(numberOf(/^Teardown/)).title).toMatch(/same day/);
  });

  it('turns the flag off, disables the provider and deletes the Entra secret', () => {
    expect(body()).toMatch(/set enabled = false where key = 'work_identity_onboarding'/);
    expect(body()).toContain('Disable the Azure provider');
    expect(body()).toContain('Delete the Entra client secret');
  });

  it('checks the settings with the apikey header and the authorize endpoint', () => {
    expect(body()).toMatch(/curl -s -H "apikey: <dev publishable key>" https:\/\/<dev-ref>\.supabase\.co\/auth\/v1\/settings/);
    expect(body()).toContain('.external.azure');
    expect(body()).toContain('/auth/v1/authorize?provider=azure');
    expect(body()).toMatch(/not `302`/);
  });

  it('ends the sessions of A and B and checks none remain (audit item 2)', () => {
    expect(body()).toContain("delete from auth.sessions where user_id in ('<user A id>', '<user B id>');");
    expect(body()).toMatch(/as sessions_left from auth\.sessions/);
    expect(body()).toMatch(/`sessions_left` is `0`/);
  });

  it('restores the recorded signup, Site URL and Redirect URLs, and reads them back (audit item 2)', () => {
    expect(body()).toContain('Restore the signup and URL settings');
    expect(body()).toMatch(/jq '\{disable_signup, site_url, uri_allow_list\}'/);
    expect(body()).toMatch(/Good: all three equal the recorded values/);
  });

  it('names exactly the rows that stay, and never calls them archived (audit item 2)', () => {
    expect(runbook).not.toMatch(/\barchived, not deleted\b/);
    for (const row of ['auth.users', 'auth.identities', 'public.users', 'work_identity_bindings', 'deal_memberships', 'audit_log']) {
      expect(body(), row).toContain(row);
    }
  });

  it('restores the recorded signup setting, revokes the invites and unmaps the firm', () => {
    expect(body()).toMatch(/recorded in step 1/);
    expect(body()).toContain('CONFIRM=1');
    expect(body()).toContain('revoke-work-identity-invites.ts');
    expect(body()).toContain('PROVIDER=none');
    expect(body()).toContain('set-firm-identity-provider.ts');
  });

  it('leaves the two test users in place', () => {
    expect(body()).toMatch(/Leave rows A and B in place/);
  });
});

describe('the next tenant section', () => {
  it('carries the per-project table of the 2/6 merge precondition (T10)', () => {
    const next = runbook.slice(runbook.indexOf('## Next tenant'), runbook.indexOf('## Evidence record template'));
    expect(next).toMatch(/^\| Hosted project \| Hook gate passed \(step 2\) \| Code PR 1\/6 migration applied \| Who checked, when \|$/m);
    for (const project of ['dev', 'staging', 'production', 'Ignatious Google sign-in project']) expect(next, project).toContain(`| ${project} |`);
  });

  it('says code PRs 1/6 and 2/6 must be deployed before the flag goes on anywhere real', () => {
    expect(runbook.slice(0, runbook.indexOf('## 1. '))).toMatch(
      /merged \*\*and deployed on every project that has external-provider users before the flag goes on anywhere but this dev proof\*\*/,
    );
  });
});

describe('the operator scripts (audit item 1)', () => {
  const scriptCommands = () => commands(runbook, 'env -u').filter((c) => /scripts\/[a-z-]+\.ts/.test(c));

  it('runs every script with the hosted variables unset and the expected dev ref', () => {
    expect(scriptCommands()).toHaveLength(3);
    for (const command of scriptCommands()) {
      expect(command).toMatch(/^env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SECRET_KEY /);
      expect(command).toContain('EXPECT_SUPABASE_REF=<dev-ref>');
      expect(command).toContain('node --env-file=.env.<dev>');
    }
  });

  it('has no script command without the guard', () => {
    expect(runbook.match(/--import tsx scripts\//g)).toHaveLength(scriptCommands().length);
  });
});

describe('house rules', () => {
  it('has no /v2.0 tenant URL in the runbook, the contract or the decision-log rows', () => {
    const tenantUrlWithSuffix = /login\.microsoftonline\.com\/[^\s`)]*\/v2\.0/;
    expect(runbook).not.toMatch(tenantUrlWithSuffix);
    expect(contract).not.toMatch(tenantUrlWithSuffix);
    for (const row of decisionLog.split('\n').filter((l) => /^\| D(97|98) /.test(l))) expect(row).not.toMatch(tenantUrlWithSuffix);
  });

  it('holds no secret-shaped string, tenant id or address', () => {
    expect(runbook).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // a JWT, such as a key
    expect(runbook).not.toMatch(/sb_(secret|publishable)_/);
    expect(runbook).not.toMatch(/[A-Za-z0-9_.-]{3,}~[A-Za-z0-9_.~-]{20,}/); // an Entra client secret value
    expect(runbook).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // a literal tenant, app or user id
    expect(runbook).not.toMatch(/\b[A-Za-z0-9_-]{40,}\b/); // a long opaque token
    expect(runbook).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });

  it('puts no token or key in a command: variables and placeholders only', () => {
    for (const command of commands(runbook, 'curl')) {
      for (const match of command.matchAll(/Authorization: Bearer (\S+)/g)) expect(match[1].replace(/"$/, '')).toBe('$SUPABASE_ACCESS_TOKEN');
      for (const match of command.matchAll(/apikey: ([^"]+)"/g)) expect(match[1]).toBe('<dev publishable key>');
    }
  });

  it('sends the apikey header on every health and settings call', () => {
    const calls = commands(runbook, 'curl').filter((c) => /\/auth\/v1\/(health|settings)/.test(c));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call).toMatch(/-H "apikey: <dev publishable key>"/);
  });

  it('has no em dash', () => {
    expect(runbook).not.toContain('—');
  });

  it('uses the csp-runbook conventions: the human-step marker and placeholders', () => {
    expect(runbook).toMatch(/\(human step\)/);
    expect(runbook).toContain('<dev-ref>');
    expect(runbook).toContain('<tenant-id>');
  });
});

describe('the other docs this PR touches', () => {
  it('links the runbook from production-bootstrap and from the contract HQ2 row', () => {
    expect(bootstrap).toContain('(./m365-sso-runbook.md)');
    const hq2 = contract.split('\n').find((l) => l.startsWith('| HQ2 |'));
    expect(hq2).toBeDefined();
    expect(hq2).toContain('m365-sso-runbook.md');
    expect(hq2).toMatch(/without a `\/v2\.0` suffix/);
  });

  it('adds D98 and D99 once each, in order after D96, marked Proposed with the number to confirm', () => {
    const rows = decisionLog.split('\n').filter((l) => /^\| D\d+ /.test(l));
    const ids = rows.map((l) => Number(/^\| D(\d+) /.exec(l)?.[1]));
    // Other PRs append their own rows (D97, D100 and on), so only the relative order is pinned.
    for (const id of [98, 99]) expect(ids.filter((n) => n === id), `D${id}`).toHaveLength(1);
    expect(ids.indexOf(96)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(96)).toBeLessThan(ids.indexOf(98));
    expect(ids.indexOf(98)).toBeLessThan(ids.indexOf(99));
    for (const id of [98, 99]) {
      const row = rows.find((l) => l.startsWith(`| D${id} `)) ?? '';
      expect(row, `D${id}`).toMatch(/Proposed/);
      expect(row, `D${id}`).toMatch(/number to confirm at merge/);
      expect(row, `D${id}`).not.toContain('—');
    }
    expect(rows.find((l) => l.startsWith('| D98 '))).toMatch(/tenant member/);
    expect(rows.find((l) => l.startsWith('| D98 '))).toMatch(/Accepted limitation/);
    expect(rows.find((l) => l.startsWith('| D99 '))).toMatch(/work_identity_hook/);
    expect(rows.find((l) => l.startsWith('| D99 '))).toMatch(/refresh/);
  });

  it('has relative links that resolve, in the runbook and in the lines this PR adds elsewhere', () => {
    const decisionRows = decisionLog.split('\n').filter((l) => /^\| D(97|98) /.test(l)).join('\n');
    const hq2 = contract.split('\n').find((l) => l.startsWith('| HQ2 |')) ?? '';
    const bootstrapLine = bootstrap.split('\n').find((l) => l.includes('m365-sso-runbook.md')) ?? '';
    const cases: [string, string, string][] = [
      ['runbook', runbookPath, runbook],
      ['decision log rows', decisionLogPath, decisionRows],
      ['contract HQ2', contractPath, hq2],
      ['production bootstrap', bootstrapPath, bootstrapLine],
    ];
    for (const [name, file, text] of cases) {
      const links = relativeLinks(text);
      expect(links.length, name).toBeGreaterThan(0);
      for (const link of links) expect(existsSync(resolve(dirname(file), link)), `${name}: ${link}`).toBe(true);
    }
  });
});
