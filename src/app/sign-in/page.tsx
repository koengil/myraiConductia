import { Suspense } from 'react';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { workIdentityErrorCopy } from '@/lib/auth/workIdentity';
import SignInPage from './page.client';

type SignInRouteProps = {
  searchParams: Promise<{ error?: string | string[] }>;
};

export default async function SignInRoute({ searchParams }: SignInRouteProps) {
  const workIdentityEnabled = await isFlagEnabled('work_identity_onboarding');
  const params = await searchParams;
  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  // Work-account round trips return here with an error code; the copy is
  // resolved on the server so the client bundle never loads node:crypto.
  const workIdentityError =
    workIdentityEnabled && errorCode ? workIdentityErrorCopy(errorCode).message : null;
  return (
    <Suspense fallback={null}>
      <SignInPage
        workIdentityEnabled={workIdentityEnabled}
        workIdentityError={workIdentityError}
      />
    </Suspense>
  );
}
