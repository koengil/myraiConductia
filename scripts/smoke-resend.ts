import { sendInviteEmail, sendInviteVerificationEmail } from '../src/lib/email/resend';
import { defaultFromAddress, getEmailTransport } from '../src/lib/email/transport';

// Manual Resend smoke (CI has no live mail credentials — run locally):
//   npm run smoke:resend -- you@example.com
// Sends one outbox-path message and both invite-path messages through the
// same modules the app uses. Does not create an invitation row.
async function main(): Promise<void> {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: npm run smoke:resend -- you@example.com');
    process.exit(1);
  }

  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set');
  }
  if (!process.env.RESEND_FROM) {
    throw new Error('RESEND_FROM is not set');
  }
  // The brand mark is served from the application's own origin, so the smoke
  // needs a real one. Fail closed rather than invent a default: a guessed
  // origin would send a broken image to a real inbox.
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_ORIGIN;
  if (!origin) {
    throw new Error('NEXT_PUBLIC_APP_URL (or APP_ORIGIN) is not set');
  }

  const inviteFrom = process.env.RESEND_FROM;
  const outboxFrom = defaultFromAddress();
  const transport = getEmailTransport();
  const stamp = new Date().toISOString();

  console.log(`provider: ${transport.provider}`);
  console.log(`RESEND_FROM: ${inviteFrom}`);
  console.log(`EMAIL_FROM: ${outboxFrom}`);
  console.log(`to: ${to}`);
  console.log(`origin: ${origin}`);

  const outbox = await transport.send({
    from: outboxFrom,
    to: [to],
    subject: `Conductia Resend smoke (${stamp})`,
    text: [
      'If you received this, the outbox transport can send from the verified domain.',
      `Provider: ${transport.provider}`,
      `From: ${outboxFrom}`,
    ].join('\n'),
  });
  console.log(`↑ outbox: ${outbox.id}${outbox.simulated ? ' (simulated)' : ''}`);

  await sendInviteEmail({
    to,
    acceptUrl: 'https://conductia.com/#resend-smoke',
    origin,
    inviterName: 'Resend smoke',
    companyName: 'Conductia',
    dealCodename: null,
    idempotencyKey: `smoke-invite-${stamp}`,
  });
  console.log('↑ invite: branded invitation template');

  await sendInviteVerificationEmail({
    to,
    verificationCode: '000000',
    challengeVersion: 1,
    origin,
    idempotencyKey: `smoke-verify-${stamp}`,
  });
  console.log('↑ verify: challenge-code template');

  console.log('✅ Resend smoke sent. Check the inbox (and spam) for three messages.');
}

main().catch((err) => {
  console.error('❌ Resend smoke failed:', err);
  process.exit(1);
});
