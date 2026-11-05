import { test as setup } from '@playwright/test';
import {
  ADMIN_EMAIL,
  ADMIN_STATE_PATH,
  EXTERNAL_EMAIL,
  EXTERNAL_STATE_PATH,
  MD_EMAIL,
  MD_STATE_PATH,
  MEMBER_EMAIL,
  MEMBER_STATE_PATH,
  mintSeededSession,
} from './session';

/**
 * The setup project. E2E specs do not drive /sign-in: the auth boundary is
 * covered at the unit tier (tests/middleware-mfa.test.ts, sign-in-mfa,
 * two-factor-page, mfa-policy, mfa-bypass) and re-driving it in a browser adds
 * cost without adding coverage (design D2).
 *
 * The invitee is deliberately NOT minted here. Their session must come from the
 * real acceptance path — the Supabase action link, the challenge, the accept
 * endpoint — which is the thing the invite journey exists to prove.
 */

// The MD's mint is unconditional: md-spine depends on this identity under the
// `live` project, so the mint must always succeed there. The firm admin's mint
// is gated below because nothing in `live` uses it: the invite journey is the
// sole consumer of the admin state, and it `test.skip`s itself under `live`
// (design D7). Minting it unconditionally would couple a live run's setup to an
// account whose existence and password on a deployed environment this suite has
// no control over — a mismatch there would fail setup, and with it md-spine,
// for a dependency md-spine never actually needs. The route-guard journey gates
// its own second identity on the same reasoning.
setup('mint the MD session', async ({ baseURL }) => {
  await mintSeededSession(MD_EMAIL, MD_STATE_PATH, baseURL);
});

setup('mint the firm-admin session', async ({ baseURL }) => {
  setup.skip(Boolean(process.env.E2E_BASE_URL), 'only the hermetic invite journey needs it');
  await mintSeededSession(ADMIN_EMAIL, ADMIN_STATE_PATH, baseURL);
});

// Gated for the same reason as the firm admin: the step-ownership journey is
// the sole consumer and skips itself under `live`, so a deployed environment
// must not have its setup coupled to a seeded member account it does not own.
setup('mint the bank-member session', async ({ baseURL }) => {
  setup.skip(Boolean(process.env.E2E_BASE_URL), 'only the hermetic step-ownership journey needs it');
  await mintSeededSession(MEMBER_EMAIL, MEMBER_STATE_PATH, baseURL);
});

setup('mint the external counterparty session', async ({ baseURL }) => {
  setup.skip(Boolean(process.env.E2E_BASE_URL), 'only the hermetic data-room wall journey needs it');
  await mintSeededSession(EXTERNAL_EMAIL, EXTERNAL_STATE_PATH, baseURL);
});
