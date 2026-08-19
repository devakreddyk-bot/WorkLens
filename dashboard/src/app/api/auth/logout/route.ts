import { NextResponse } from 'next/server';

import { assertEnv } from '@/lib/env';
import { buildLogoutUrl } from '@/lib/oauth';
import { COOKIE } from '@/lib/session';

/**
 * Signs out.
 *
 * Clears this application's cookies *and* redirects through Cognito's logout endpoint. Clearing only
 * ours would leave the hosted-UI session intact, so the next sign-in would complete without a prompt —
 * which looks like the sign-out did not work, and on a shared machine means the next person is signed
 * in as the last one.
 */
export function POST(): NextResponse {
  assertEnv();

  const response = NextResponse.redirect(buildLogoutUrl());
  for (const name of [COOKIE.idToken, COOKIE.accessToken, COOKIE.refreshToken, COOKIE.state, COOKIE.verifier]) {
    response.cookies.delete(name);
  }
  return response;
}
