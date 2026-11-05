// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The origin definers (20261023140400_discovery_origin_read.sql, G-02b #173) read past RLS, so what they may return and
// who may call them is pinned here beside the SQL probes (supabase/tests/definer_grants.sql, discovery_health.sql and
// discovery_model_proposal_accepts.sql run the real functions).

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261023140400_discovery_origin_read.sql'), 'utf8').replace(
  /--.*$/gm,
  '',
);

describe('the origin read migration', () => {
  it('defines two stable, pinned definers and grants them to authenticated alone', () => {
    const defs = [...sql.matchAll(/create or replace function (\w+)\([^)]*\)[\s\S]*?\n\$\$;/g)];
    expect(defs.map((m) => m[1])).toEqual(['discovery_candidate_origins', 'discovery_deal_origin']);
    for (const [text] of defs) {
      expect(text).toMatch(/\bstable\b/);
      expect(text).toMatch(/security definer set search_path = public, pg_temp/);
      expect(text).toContain('auth.uid()');
    }
    expect(sql).toContain('revoke all on function discovery_candidate_origins(uuid[]) from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function discovery_candidate_origins(uuid[]) to authenticated;');
    expect(sql).toContain('revoke all on function discovery_deal_origin(uuid) from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function discovery_deal_origin(uuid) to authenticated;');
    expect(sql).not.toMatch(/grant [^;]*\b(anon|public)\b/i);
  });

  it('writes nothing and returns the enum, never a cluster key', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i);
    // The only text it answers is the two words; the key is compared by its prefix and never selected out.
    expect(sql.match(/cluster_key/g)).toHaveLength(2);
    expect(sql).toContain("'model_proposal'");
    expect(sql).toContain("'rules'");
    expect(sql).toContain("left(n.cluster_key, 6) = 'model:'");
  });

  it('authorizes by seeing the candidate, or sitting on or overseeing the deal, and caps the array at 200', () => {
    expect(sql).toContain('app_can_see_candidate(dc.id, v_actor)');
    expect(sql).toContain('app_is_deal_member(d.id, v_actor)');
    expect(sql).toContain('app_is_deal_overseer(d.id, v_actor)');
    expect(sql).toMatch(/cardinality\(p_candidate_ids\) > 200/);
    expect(sql).toContain("errcode = '22023'");
    // The message is fixed: no id or key is echoed.
    const raises = [...sql.matchAll(/raise exception[^;]*;/g)].map((m) => m[0]);
    expect(raises).toHaveLength(1);
    expect(raises[0]).not.toMatch(/%|p_candidate_ids/);
  });

  it('follows merges with a depth bound and a cycle guard', () => {
    expect([...sql.matchAll(/w\.depth < 32 and m\.id <> all \(w\.path\)/g)]).toHaveLength(2);
  });
});
