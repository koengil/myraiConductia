import {afterEach,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
const m=vi.hoisted(()=>({auth:vi.fn(),flag:vi.fn(),access:vi.fn()}));
vi.mock('@/lib/api/v1/http',async original=>({...await original<object>(),requireApiUser:m.auth,resolveDealRef:async()=>({id:'d',code:'ZZ-TEST'})}));
vi.mock('@/lib/flags/requireFlag',()=>({requireFlag:m.flag}));
vi.mock('@/lib/api/v1/access',()=>({userCanAccessDeal:m.access}));
import {POST} from '@/app/api/v1/deals/[dealId]/recipient-check/route';
afterEach(()=>vi.resetAllMocks());
function setup(opts:{tenant?:string;external?:boolean;department?:string;errorTable?:string;sent?:unknown[]}={}){
 const tables:string[]=[];const writes=vi.fn();const filters:unknown[][]=[];
 const actor={tenant_id:'t',company_id:'bank',status:'active',is_external:opts.external??false,department:opts.department??'banking'};
 const data:Record<string,unknown>={users:actor,deals:{id:'d',tenant_id:opts.tenant??'t',bank_id:'bank'},deal_memberships:[],invites:[],deal_recipient_affiliations:[],deal_parties:[],company_verified_domains:[{domain:'bank.test'}],outbound_messages:opts.sent??[]};
 const admin={from(table:string){tables.push(table);const q={select:()=>q,eq:(...args:unknown[])=>{filters.push([table,...args]);return q;},in:()=>q,order:()=>q,limit:()=>q,insert:writes,update:writes,maybeSingle:async()=>({data:table==='companies'?{tenant_id:'t'}:data[table],error:opts.errorTable===table?{}:null}),then:(f:(v:unknown)=>unknown)=>Promise.resolve({data:table==='companies'?[{id:'bank',tenant_id:'t'}]:data[table],error:opts.errorTable===table?{}:null}).then(f)};return q;}} as unknown as SupabaseClient;
 m.auth.mockResolvedValue({ok:true,user:{id:'actor'},admin});m.flag.mockResolvedValue(null);m.access.mockResolvedValue(true);return {tables,writes,filters};
}
const call=(body:unknown={to:['zz-test@outside.test'],cc:[],bcc:[]})=>POST(new Request('http://localhost',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({dealId:'ZZ-TEST'})});
it('returns only submitted recipients with private no-store and no writes',async()=>{const {writes}=setup();const r=await call();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');const b=await r.json();expect(b.recipients).toHaveLength(1);expect(b.recipients[0]).toMatchObject({email:'zz-test@outside.test',reason:'not_on_deal',requiresConfirmation:true});expect(writes).not.toHaveBeenCalled();});
it('denies a sender from another tenant',async()=>{const {tables}=setup({tenant:'other'});expect((await call()).status).toBe(403);expect(tables).not.toContain('deal_recipient_affiliations');});
it.each([{external:true},{department:'research'},{department:'trading'}])('does not review an external or walled sender %j, and does not refuse them either',async opts=>{const {tables}=setup(opts);const r=await call();expect(r.status).toBe(200);expect(await r.json()).toMatchObject({recipients:[],reviewed:false});expect(tables).not.toContain('deal_recipient_affiliations');});
it('answers inaccessible deals as missing before loading relationships',async()=>{const {tables}=setup();m.access.mockResolvedValue(false);const r=await call();expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'Deal not found'});expect(tables).not.toContain('deal_recipient_affiliations');});
it('an outsider already on this deal\'s sent mail needs no second approval, read from SENT deal mail only (Issue #378)',async()=>{
 const {filters,writes}=setup({sent:[{to_emails:['someone@bank.test'],cc_emails:['ZZ-Test@Outside.test'],bcc_emails:null}]});
 const b=await (await call({to:[],cc:['zz-test@outside.test'],bcc:[]})).json();
 expect(b.recipients[0]).toMatchObject({email:'zz-test@outside.test',knownToDeal:true,requiresConfirmation:false,reason:null});
 expect(filters).toEqual(expect.arrayContaining([['outbound_messages','deal_id','d'],['outbound_messages','tenant_id','t'],['outbound_messages','status','sent']]));
 expect(writes).not.toHaveBeenCalled();
});
it.each(['users','deals','deal_memberships','invites','deal_recipient_affiliations','deal_parties','companies','company_verified_domains','outbound_messages'])('lookup failure at %s cannot become an empty trusted result',async errorTable=>{setup({errorTable});const r=await call();expect(r.status).toBe(503);expect(await r.json()).not.toHaveProperty('recipients');});
it('requires authentication and the mail flag',async()=>{setup();m.auth.mockResolvedValue({ok:false,response:new Response(null,{status:401})});expect((await call()).status).toBe(401);m.flag.mockResolvedValue(new Response(null,{status:404}));expect((await call()).status).toBe(404);});
it('rejects invalid or excessive recipient input',async()=>{setup();for(const body of [{to:['invalid']},{bcc:Array(21).fill('zz-test@outside.test')}])expect((await call(body)).status).toBe(400);});
