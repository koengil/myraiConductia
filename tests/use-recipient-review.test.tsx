import { act,cleanup,renderHook,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { useRecipientReview } from '@/components/mail/useRecipientReview';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('keeps changed recipients unverified until their current response arrives',async()=>{
 const pending:((value:unknown)=>void)[]=[];
 vi.stubGlobal('fetch',vi.fn(()=>new Promise(done=>pending.push(done))));
 const view=renderHook(({to})=>useRecipientReview('ZZ-TEST',{to:[to],cc:[],bcc:[]},0),{initialProps:{to:'a@client.test'}});
 await waitFor(()=>expect(pending).toHaveLength(1));
 view.rerender({to:'b@buyer.test'});await waitFor(()=>expect(pending).toHaveLength(2));
 await act(async()=>pending[0]({ok:true,json:async()=>({recipients:[]})}));
 expect(view.result.current.status).toBe('loading');
 await act(async()=>pending[1]({ok:true,json:async()=>({recipients:[]})}));
 expect(view.result.current.status).toBe('ready');
});
it('reports errors and retries without an internal assertion',async()=>{
 const fetcher=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ok:true,json:async()=>({recipients:[]})});vi.stubGlobal('fetch',fetcher);
 const view=renderHook(()=>useRecipientReview('ZZ-TEST',{to:['a@client.test'],cc:[],bcc:[]},0));
 await waitFor(()=>expect(view.result.current.status).toBe('error'));
 act(()=>view.result.current.retry());await waitFor(()=>expect(view.result.current.status).toBe('ready'));
});
