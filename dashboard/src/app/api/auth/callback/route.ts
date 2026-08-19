import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { assertEnv, publicEnv } from '@/lib/env';
import { exchangeCodeForTokens, tokenCookieOptions } from '@/lib/oauth';
import { COOKIE } from '@/lib/session';

/** Thirty days, matching the refresh token's configured validity. */
const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Completes the sign-in flow.
 *
 * The order of checks matters. State is compared before the code is used, so a forged callback is
 * rejected without a token exchange; the one-time cookies are cleared on every path, success or
 * failure, so a replayed callback finds nothing to work with.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  assertEnv();

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const appUrl = publicEnv.appUrl.replace(/\/$/, '');
  const fail = (reason: string): NextResponse => {
    const response = NextResponse.redirect(`${appUrl}/login?reason=${encodeURIComponent(reason)}`);
    // Cleared even on failure: leaving a verifier behind would let a second, forged callback reuse it.
    response.cookies.delete(COOKIE.state);
    response.cookies.delete(COOKIE.verifier);
    return response;
  };

  // Cognito reports a declined consent or a failed challenge this way. Not an error worth a stack
  // trace — the person simply did not complete sign-in.
  if (error !== null) {
    return fail(error === 'access_denied' ? 'cancelled' : 'provider-error');
  }

  const expectedState = request.cookies.get(COOKIE.state)?.value;
  const verifier = request.cookies.get(COOKIE.verifier)?.value;

  if (expectedState === undefined || verifier === undefined) {
    // The cookies expired, or this callback was opened in a different browser from the one that
    // started the flow. Either way the flow has to restart.
    return fail('expired');
  }

  if (state === null || state !== expectedState) {
    return fail('state-mismatch');
  }

  if (code === null || code === '') {
    return fail('no-code');
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, verifier);
  } catch {
    // Nothing from the exchange is surfaced to the browser: Cognito echoes request parameters on some
    // errors, and one of them is the verifier.
    return fail('exchange-failed');
  }

  const response = NextResponse.redirect(`${appUrl}/`);

  // The ID and access tokens are given the token's own lifetime, so the cookie and the credential
  // expire together and a stale cookie cannot produce a page that renders and then 401s.
  response.cookies.set(COOKIE.idToken, tokens.idToken, tokenCookieOptions(tokens.expiresIn));
  response.cookies.set(COOKIE.accessToken, tokens.accessToken, tokenCookieOptions(tokens.expiresIn));

  if (tokens.refreshToken !== null) {
    response.cookies.set(COOKIE.refreshToken, tokens.refreshToken, tokenCookieOptions(REFRESH_MAX_AGE_SECONDS));
  }

  response.cookies.delete(COOKIE.state);
  response.cookies.delete(COOKIE.verifier);

  return response;
}
