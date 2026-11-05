import { afterEach, expect, it, vi } from 'vitest';
import { mintRecipientToken, verifyRecipientToken } from '@/lib/compliance/recipientToken';
afterEach(()=>vi.unstubAllEnvs());
const subject={actorId:'a',tenantId:'t',dealId:'d',messageDigest:'message-hash',policyFingerprint:'policy-hash'};
function token(now=1000000){vi.stubEnv('OUTBOX_SCREEN_SECRET','test-only');return mintRecipientToken(subject,now);}
it('validates exact subject',()=>{expect(verifyRecipientToken(token(),subject,1000001)).toBe(true);});
it.each(['actorId','tenantId','dealId','messageDigest','policyFingerprint'] as const)('binds %s',key=>{expect(verifyRecipientToken(token(),{...subject,[key]:'changed'},1000001)).toBe(false);});
it.each([999999,1600001])('rejects future issuance or expired token at %s',now=>{expect(verifyRecipientToken(token(),subject,now)).toBe(false);});
it('rejects a tampered or malformed signature',()=>{const t=token();expect(verifyRecipientToken(t+'x',subject,1000001)).toBe(false);expect(verifyRecipientToken('x.y',subject,1000001)).toBe(false);expect(verifyRecipientToken(true,subject,1000001)).toBe(false);});
it('requires server key configuration',()=>{vi.stubEnv('OUTBOX_SCREEN_SECRET','');vi.stubEnv('INVITE_VERIFICATION_PEPPER','');expect(()=>mintRecipientToken(subject)).toThrow();});
