/**
 * Configuration, validated once.
 *
 * There is one object, `publicEnv`, and everything in it is compiled into the browser bundle. An
 * earlier version of this comment described a second `serverEnv` for values that must not be — it
 * was never written, because it turned out nothing needed it. Nothing here is a secret: the Cognito
 * client is public by design (authorisation-code flow with PKCE, no client secret), the tokens live
 * in `httpOnly` cookies the browser cannot read, and every API call goes through a Server Component
 * or Server Action. If a genuinely server-only value ever arrives, it needs its own module rather
 * than a second export here — a `NEXT_PUBLIC_` prefix is what decides what ships, and a value in
 * this file without one is a trap waiting for somebody to add the prefix "for consistency".
 */

const missing: string[] = [];

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    missing.push(name);
    return '';
  }
  return value.trim();
}

/**
 * Values referenced from the browser. Next.js inlines `NEXT_PUBLIC_*` at build time, so these are
 * read as literal property accesses rather than through a dynamic key — a variable index would not be
 * substituted and would be undefined at run time.
 */
export const publicEnv = {
  apiBaseUrl: required('NEXT_PUBLIC_API_BASE_URL', process.env.NEXT_PUBLIC_API_BASE_URL),
  cognitoDomain: required('NEXT_PUBLIC_COGNITO_DOMAIN', process.env.NEXT_PUBLIC_COGNITO_DOMAIN),
  cognitoClientId: required('NEXT_PUBLIC_COGNITO_CLIENT_ID', process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID),
  appUrl: required('NEXT_PUBLIC_APP_URL', process.env.NEXT_PUBLIC_APP_URL),
} as const;

/** The redirect URI must match a callback URL registered on the Cognito app client exactly. */
export const callbackUrl = `${publicEnv.appUrl.replace(/\/$/, '')}/api/auth/callback`;

/**
 * Fails loudly, at the point of use, naming every missing variable at once.
 *
 * Deliberately not thrown at module load: a missing variable would then break the build rather than
 * the page, and the error would arrive without the context of which page needed it. `make
 * env-dashboard` generates all of these from the Terraform outputs.
 */
export function assertEnv(): void {
  if (missing.length > 0) {
    throw new Error(
      `Dashboard configuration is incomplete. Missing: ${missing.join(', ')}.\n` +
        `Generate dashboard/.env.local from the deployed stack with:\n  make env-dashboard > dashboard/.env.local`,
    );
  }
}
