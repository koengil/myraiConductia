import * as React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
const nav=vi.hoisted(()=>({projectId:'ZZ-A'}));
vi.mock('next/navigation',()=>({useParams:()=>nav}));
// The deal is in the viewer's list (S6R4-02): Mail renders for it.
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  const deals = [
    { id: 'ZZ-A', code: 'ZZ-A', codename: 'Project A' },
    { id: 'ZZ-B', code: 'ZZ-B', codename: 'Project B' },
  ];
  return {
    ...actual,
    useDeals: () => ({ state: { status: 'ready', deals }, deals, loading: false, error: false, reload: () => {} }),
  };
});
vi.mock('@/components/mail/MailComposer',()=>({MailComposer:({onSent}:{onSent:(status:string,recipients:unknown[])=>void})=><><button onClick={()=>onSent('sent',[{email:'zz-test@outside.test',reason:'not_on_deal'}])}>ZZ TEST complete send</button><button onClick={()=>onSent('sent',[{email:'out@outside.test',boundary:'external'},{email:'col@firm.test',boundary:'internal'}])}>ZZ TEST send sides</button></>}));
import {peekRecipientAddition,clearRecipientAddition} from '@/lib/team/recipientAddition';
import {SessionProvider} from '@/lib/session/store';
import {MailClient} from '@/components/mail/MailClient';
afterEach(()=>{cleanup();vi.unstubAllGlobals();nav.projectId='ZZ-A';});
it('does not carry a sent-recipient addition into another project',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({messages:[],user:{firm_role:null},configured:false,connected:false})}));
 const ui=<SessionProvider><MailClient/></SessionProvider>;
 const view=render(ui);
 fireEvent.click(screen.getByRole('button',{name:/new message/i}));
 fireEvent.click(screen.getByRole('button',{name:'ZZ TEST complete send'}));
 expect(await screen.findByRole('link',{name:'Invite zz-test@outside.test to deal'})).toHaveAttribute('href','/projects/ZZ-A/team');
 expect(screen.getByText('Email sent. Add the recipient to this deal.')).toBeInTheDocument();
 nav.projectId='ZZ-B';view.rerender(<SessionProvider><MailClient/></SessionProvider>);
 expect(screen.queryByRole('link',{name:'Invite zz-test@outside.test to deal'})).toBeNull();
});

it('routes an outside recipient to the Data Room and a colleague to Team',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({messages:[],user:{firm_role:null},configured:false,connected:false})}));
 render(<SessionProvider><MailClient/></SessionProvider>);
 fireEvent.click(screen.getByRole('button',{name:/new message/i}));
 fireEvent.click(screen.getByRole('button',{name:'ZZ TEST send sides'}));
 expect(await screen.findByRole('link',{name:'Give out@outside.test data room access'})).toHaveAttribute('href','/projects/ZZ-A/data-room');
 expect(screen.getByText('Email sent. Add the recipients to this deal.')).toBeInTheDocument();
 expect(screen.queryByRole('link',{name:'Invite out@outside.test to deal'})).toBeNull();
 expect(screen.getByRole('link',{name:'Invite col@firm.test to deal'})).toHaveAttribute('href','/projects/ZZ-A/team');
 expect(screen.queryByRole('link',{name:'Give col@firm.test data room access'})).toBeNull();
});

it('queues the Team prefill for a colleague and the Data Room prefill for an outside address',async()=>{
 clearRecipientAddition();
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({messages:[],user:{firm_role:null},configured:false,connected:false})}));
 render(<SessionProvider><MailClient/></SessionProvider>);
 fireEvent.click(screen.getByRole('button',{name:/new message/i}));
 fireEvent.click(screen.getByRole('button',{name:'ZZ TEST send sides'}));
 fireEvent.click(await screen.findByRole('link',{name:'Give out@outside.test data room access'}));
 expect(peekRecipientAddition('ZZ-A','team')).toBeNull();
 expect(peekRecipientAddition('ZZ-A','data-room')).toBe('out@outside.test');
 fireEvent.click(screen.getByRole('link',{name:'Invite col@firm.test to deal'}));
 expect(peekRecipientAddition('ZZ-A','team')).toBe('col@firm.test');
 clearRecipientAddition();
});
