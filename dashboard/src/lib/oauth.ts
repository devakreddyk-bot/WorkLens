/**
 * The authorisation-code flow with PKCE.
 *
 * PKCE is used even though this is a confidential-ish server-side client, because the Cognito app
 * client is configured without a secret. That is deliberate: a secret in a Vercel environment variable
 * is a secret in a place it can be read by anyone with access to the project, and PKCE gives the same
 * protection — the authorisation code is useless without the verifier, which never leaves the server's
 * cookie.
 *
 * Both the `state` and the verifier are held in short-lived `httpOnly` cookies rather than in a signed
 * blob in the URL, so a copied login link cannot be completed by anyone but the browser that started
 * it.
 */

import { createHash, randomBytes } from 'node:crypto';

import { callbackUrl, publicEnv } from './env';

/** Five minutes. Long enough to sign in and complete a TOTP challenge, short enough to be useless later. */
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 300;

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Generates a PKCE verifier and its S256 challenge.
 *
 * 32 bytes, base64url-encoded, giving a 43-character verifier — the minimum RFC 7636 allows is 43 and
 * the maximum is 128, so this sits at the short end of the legal range with a full 256 bits of entropy.
 */
export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** An unguessable value tying the callback to the request that started it. */
export function createState(): string {
  return base64Url(randomBytes(16));
}

/** The hosted-UI URL to send the browser to. */
export function buildAuthorizeUrl(state: string, challenge: string): string {
  const url = new URL('/oauth2/authorize', publicEnv.cognitoDomain);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', publicEnv.cognitoClientId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // `openid` for the ID token carrying the wl: claims; `email` so the audit log has a readable actor;
  // `profile` for the name shown in the header. No custom scopes: authorisation is decided from the
  // claims, not from scopes, so asking for more would grant nothing and disclose intent.
  url.searchParams.set('scope', 'openid email profile');
  return url.toString();
}

export interface TokenSet {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

/**
 * Exchanges an authorisation code for tokens.
 *
 * `no-store` because a cached token response would be a cached credential. The request carries the
 * verifier rather than a client secret.
 */
export async function exchangeCodeForTokens(code: string, verifier: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: publicEnv.cognitoClientId,
    code,
    redirect_uri: callbackUrl,
    code_verifier: verifier,
  });

  const response = await fetch(new URL('/oauth2/token', publicEnv.cognitoDomain), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    cache: 'no-store',
  });

  if (!response.ok) {
    // The body is deliberately not included in the thrown message: Cognito's token endpoint echoes
    // request parameters on some errors, and the verifier is one of them.
    throw new Error(`Token exchange failed (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (payload.id_token === undefined || payload.access_token === undefined) {
    throw new Error('Token exchange returned no tokens.');
  }

  return {
    idToken: payload.id_token,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in ?? 3600,
  };
}

/** The hosted-UI logout URL, which clears Cognito's own session as well as ours. */
export function buildLogoutUrl(): string {
  const url = new URL('/logout', publicEnv.cognitoDomain);
  url.searchParams.set('client_id', publicEnv.cognitoClientId);
  url.searchParams.set('logout_uri', `${publicEnv.appUrl.replace(/\/$/, '')}/login?reason=signed-out`);
  return url.toString();
}

/**
 * Cookie attributes for anything holding a token.
 *
 * `secure` is conditional only so `http://localhost` development works; every deployed origin is
 * https, which the backend's own configuration refuses to run without. `lax` rather than `strict`
 * because the OAuth callback is a cross-site navigation and `strict` would drop the cookies on the
 * way back from Cognito — the classic reason a login loops.
 */
export function tokenCookieOptions(maxAgeSeconds: number): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: publicEnv.appUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
