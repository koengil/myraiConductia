import * as React from 'react';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { queueRecipientAddition,peekRecipientAddition,clearRecipientAddition } from '@/lib/team/recipientAddition';
import { InviteModal } from '@/components/team/InviteModal';
afterEach(()=>{cleanup();vi.unstubAllGlobals();clearRecipientAddition();});
it('keeps the recipient handoff only in memory and scoped to its project',()=>{
 queueRecipientAddition('ZZ-A','zz-test@client.test','team');expect(peekRecipientAddition('ZZ-B','team')).toBeNull();expect(peekRecipientAddition('ZZ-A','team')).toBe('zz-test@client.test');clearRecipientAddition();expect(peekRecipientAddition('ZZ-A','team')).toBeNull();
});
it('keeps the Team and Data Room handoffs apart',()=>{
 queueRecipientAddition('ZZ-A','out@x.test','data-room');expect(peekRecipientAddition('ZZ-A','team')).toBeNull();expect(peekRecipientAddition('ZZ-A','data-room')).toBe('out@x.test');clearRecipientAddition();
});
it('prefills the governed invite and defaults internal access to Observer',()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,json:async()=>({})}));
 render(<InviteModal dealId="ZZ-TEST" roster={{bankCompanyId:'bank',members:[],parties:[]}} viewer={{id:'u',isExternal:false,firmRole:'admin',companyId:'bank',companyRole:'director',isDealMd:true}} initialRecipientEmail="zz-test@bank.test" onClose={vi.fn()} onCreated={vi.fn()} onResend={vi.fn()}/>);
 expect(screen.getByLabelText(/^email/i)).toHaveValue('zz-test@bank.test');
 fireEvent.change(screen.getByLabelText(/^company/i),{target:{value:'bank'}});
 expect(screen.getByLabelText('Role')).toHaveValue('read_only');
});
