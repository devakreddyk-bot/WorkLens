import { NextResponse } from 'next/server';

import { assertEnv } from '@/lib/env';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  OAUTH_COOKIE_MAX_AGE_SECONDS,
  tokenCookieOptions,
} from '@/lib/oauth';
import { COOKIE } from '@/lib/session';

/**
 * Starts the sign-in flow.
 *
 * A route rather than a link so the state and the PKCE verifier can be minted server-side and set as
 * cookies in the same response that redirects. Generating them in the browser would put the verifier
 * somewhere a script could read it, which is the thing PKCE exists to prevent.
 */
export function GET(): NextResponse {
  assertEnv();

  const state = createState();
  const { verifier, challenge } = createPkcePair();

  const response = NextResponse.redirect(buildAuthorizeUrl(state, challenge));
  const options = tokenCookieOptions(OAUTH_COOKIE_MAX_AGE_SECONDS);

  response.cookies.set(COOKIE.state, state, options);
  response.cookies.set(COOKIE.verifier, verifier, options);

  return response;
}
