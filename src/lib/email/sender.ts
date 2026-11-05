import { OperatorCopyError } from '../errors/upstream';

export const SANDBOX_SENDER_ADDRESS = 'onboarding@resend.dev';

const SANDBOX_SENDER = `Conductia <${SANDBOX_SENDER_ADDRESS}>`;

export type SenderVariable = 'RESEND_FROM' | 'EMAIL_FROM';

export function senderProblem(variable: SenderVariable, value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) {
    return `${variable} is not set, so mail falls back to the ${SANDBOX_SENDER_ADDRESS} sandbox sender`;
  }
  if (configured.toLowerCase().includes(SANDBOX_SENDER_ADDRESS)) {
    return `${variable} is the ${SANDBOX_SENDER_ADDRESS} sandbox sender`;
  }
  return null;
}

export const SENDER_REMEDY =
  'Resend accepts that sender and answers 200, then delivers only to the Resend account owner: ' +
  'the recipient gets nothing and the send reads as successful. ' +
  'Set it to an address on a verified Resend domain.';

export function resolveSender(
  variable: SenderVariable,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[variable]?.trim();
  const problem = senderProblem(variable, configured);
  if (!problem) return configured as string;
  if (env.NEXT_PUBLIC_APP_ENV !== 'dev') {
    throw new OperatorCopyError(`${problem}. ${SENDER_REMEDY}`);
  }
  return configured || SANDBOX_SENDER;
}
