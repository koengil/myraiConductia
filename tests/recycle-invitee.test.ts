import {expect,it} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {recycleInvitee} from '../scripts/lib/recycleInvitee';
function fixture(failAffiliation=false){const calls:{table:string;operation:string;filter?:unknown}[]=[];const admin={from(table:string){let operation='select';const q={select:()=>q,like:()=>q,delete:()=>{operation='delete';return q;},eq:(_key:string,value:unknown)=>{calls.push({table,operation,filter:value});return q;},in:(key:string,value:unknown)=>{calls.push({table,operation,filter:{[key]:value}});return q;},maybeSingle:async()=>({data:null,error:null}),then:(f:(v:unknown)=>unknown)=>Promise.resolve({data:table==='invites'&&operation==='select'?[{id:'zz-invite'}]:null,count:1,error:table==='deal_recipient_affiliations'&&failAffiliation?{message:'unavailable'}:null}).then(f)};return q;}} as unknown as SupabaseClient;return {admin,calls};}
it('cleans only affiliations of the recycled invitations before deleting invites',async()=>{const {admin,calls}=fixture();await recycleInvitee(admin,'ZZ-TEST@outside.test');const affiliation=calls.findIndex(c=>c.table==='deal_recipient_affiliations'&&c.operation==='delete');const invite=calls.findIndex(c=>c.table==='invites'&&c.operation==='delete');expect(affiliation).toBeGreaterThanOrEqual(0);expect(affiliation).toBeLessThan(invite);expect(calls[affiliation].filter).toEqual({invite_id:['zz-invite']});});
it('does not delete invitations if affiliation cleanup fails',async()=>{const {admin,calls}=fixture(true);await expect(recycleInvitee(admin,'zz-test@outside.test')).rejects.toThrow('affiliations delete failed');expect(calls.some(c=>c.table==='invites'&&c.operation==='delete')).toBe(false);});

// Audit round 1, item 13: an invite delete cascades to its mailbox consent, so
// the recycled identity must lose its seat (which withdraws the consent through
// the seat-loss trigger, audited) BEFORE any invite is deleted.
it('unseats the identity before it deletes any invitation', async () => {
  const events: string[] = [];
  const admin = {
    from(table: string) {
      let operation = 'select';
      const q: Record<string, unknown> = {
        select: () => q,
        like: () => q,
        delete: () => { operation = 'delete'; return q; },
        update: (patch: Record<string, unknown>) => { operation = `update:${patch.status ?? ''}:${patch.company_id ?? 'null'}`; return q; },
        eq: () => { if (operation !== 'select') events.push(`${table}.${operation}`); return q; },
        in: () => { events.push(`${table}.${operation}`); return q; },
        maybeSingle: async () => ({ data: table === 'users' ? { id: 'zz-user', status: 'active' } : null, error: null }),
        then: (f: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === 'invites' && operation === 'select' ? [{ id: 'zz-invite' }] : null, count: 1, error: null }).then(f),
      };
      return q;
    },
    auth: { admin: { updateUserById: async () => { events.push('auth.tombstone'); return { error: null }; } } },
  } as unknown as SupabaseClient;

  const result = await recycleInvitee(admin, 'zz-test@outside.test');

  const unseat = events.indexOf('users.update:suspended:null');
  const inviteDelete = events.indexOf('invites.delete');
  expect(unseat).toBeGreaterThanOrEqual(0);
  expect(inviteDelete).toBeGreaterThan(unseat);
  expect(result.tombstone).toMatch(/^zz-test\+used-\d+@outside\.test$/);
});
