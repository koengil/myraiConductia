import * as React from 'react';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { RecipientAffiliationEditor } from '@/components/team/RecipientAffiliationEditor';
const roster={bankCompanyId:'bank',members:[{userId:'u',email:'zz-test@client.test',companyId:'client',fullName:'ZZ TEST',displayName:null,dealRole:'seller',phase:0,isExternal:true,companyName:'Client',companyRole:'member'}],parties:[{companyId:'client',companyName:'Client',partyRole:'target'},{companyId:'buyer',companyName:'Buyer',partyRole:'counterparty'}]};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('saves affiliation independently of the existing access role',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({affiliations:[]})}).mockResolvedValueOnce({ok:true,json:async()=>({affiliation:{normalized_email:'zz-test@client.test',affiliation:'client_advisor',represented_company_id:'buyer',revision:1}})});vi.stubGlobal('fetch',fetcher);
 render(<RecipientAffiliationEditor dealId="ZZ-TEST" roster={roster} invites={[]}/>);
 fireEvent.change(await screen.findByLabelText('Person'),{target:{value:'user:u'}});
 fireEvent.change(screen.getByLabelText('Deal relationship'),{target:{value:'client_advisor'}});
 fireEvent.change(screen.getByLabelText('Represented deal party'),{target:{value:'buyer'}});
 fireEvent.click(screen.getByRole('button',{name:'Save relationship'}));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 const body=JSON.parse(fetcher.mock.calls[1][1].body);
 expect(body).toEqual(expect.objectContaining({userId:'u',affiliation:'client_advisor',representedCompanyId:'buyer',expectedRevision:null}));expect(body.dealRole).toBeUndefined();
});
it('does not expose the editor to an unauthorized viewer',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));render(<RecipientAffiliationEditor dealId="ZZ-TEST" roster={roster} invites={[]}/>);
 await waitFor(()=>expect(screen.queryByText('Loading recipient relationships.')).not.toBeInTheDocument());expect(screen.queryByLabelText('Person')).not.toBeInTheDocument();
});
