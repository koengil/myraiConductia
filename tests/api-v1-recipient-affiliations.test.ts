import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const m = vi.hoisted(() => ({auth:vi.fn(), flag:vi.fn(), manage:vi.fn(), access:vi.fn()}));
vi.mock('@/lib/api/v1/http', async original => ({...await original<object>(), requireApiUser:m.auth, resolveDealRef:async()=>({id:'d1',code:'ZZ-TEST'})}));
vi.mock('@/lib/flags/requireFlag',()=>({requireFlag:m.flag}));
vi.mock('@/lib/api/v1/access',()=>({canManageDealMembersChecked:m.manage,userCanAccessDeal:m.access}));
import { PUT, GET } from '@/app/api/v1/deals/[dealId]/recipient-affiliations/route';
afterEach(()=>vi.resetAllMocks());
function setup(opts:{external?:boolean; tenant?:string; readError?:boolean; rpcError?:string}={}) {
 const rpc=vi.fn().mockResolvedValue({data:{revision:1},error:opts.rpcError?{message:opts.rpcError}:null});
 const admin={rpc,from(table:string){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:table==='users'?{tenant_id:'t1',is_external:opts.external??false,status:'active'}:{tenant_id:opts.tenant??'t1'},error:opts.readError?{}:null}),then:(f:(v:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(f)};return q;}} as unknown as SupabaseClient;
 m.auth.mockResolvedValue({ok:true,user:{id:'u1'},admin});m.flag.mockResolvedValue(null);m.manage.mockResolvedValue(true);m.access.mockResolvedValue(true);return rpc;
}
const ctx={params:Promise.resolve({dealId:'ZZ-TEST'})};
const valid={email:'ZZ-TEST@client.example',companyId:'11111111-1111-4111-8111-111111111111',affiliation:'client',representedCompanyId:null,userId:'22222222-2222-4222-8222-222222222222',inviteId:null,expectedRevision:null};
const req=(body:unknown)=>new Request('http://localhost',{method:'PUT',body:JSON.stringify(body)});
it('derives actor/deal and normalizes email for the atomic write',async()=>{const rpc=setup();expect((await PUT(req(valid),ctx)).status).toBe(200);expect(rpc).toHaveBeenCalledWith('set_recipient_affiliation',expect.objectContaining({p_actor:'u1',p_deal_id:'d1',p_email:'zz-test@client.example'}));});
it('denies a seated external manager',async()=>{const rpc=setup({external:true});expect((await PUT(req(valid),ctx)).status).toBe(403);expect(rpc).not.toHaveBeenCalled();});
// A cross-tenant caller has no seat and no oversight: the deal reads as missing (decision-log D65).
it('hides the deal from a cross-tenant manager',async()=>{const rpc=setup({tenant:'other'});m.access.mockResolvedValue(false);const res=await PUT(req(valid),ctx);expect(res.status).toBe(404);expect(await res.json()).toEqual({error:'Deal not found'});expect(rpc).not.toHaveBeenCalled();});
it('denies ordinary senders',async()=>{setup();m.manage.mockResolvedValue(false);expect((await GET(new Request('http://localhost'),ctx)).status).toBe(403);});
it('reports unreadable authority',async()=>{setup({readError:true});expect((await PUT(req(valid),ctx)).status).toBe(503);});
it.each([{...valid,affiliation:'bank_team'},{...valid,affiliation:'client_advisor'},{...valid,expectedRevision:-1},{...valid,companyId:'bad'}])('rejects invalid assignment %j',async body=>{const rpc=setup();expect((await PUT(req(body),ctx)).status).toBe(400);expect(rpc).not.toHaveBeenCalled();});
it('reports stale edits without overwrite',async()=>{setup({rpcError:'affiliation_revision_conflict'});expect((await PUT(req(valid),ctx)).status).toBe(409);});
it('does not expose unrelated constraint details',async()=>{setup({rpcError:'tenant_mismatch secret row'});const res=await PUT(req(valid),ctx);expect(res.status).toBe(403);expect(JSON.stringify(await res.json())).not.toContain('secret');});
