import type { NextConfig } from 'next';

/**
 * The dashboard displays window titles, timesheets and screenshots of people's screens. The headers
 * below are the cheap half of protecting that; the expensive half is the server-side authorisation
 * in backend/src/middleware/cognitoAuth.ts.
 */
const securityHeaders = [
  // Nothing here is ever legitimately framed. Clickjacking a payroll export or an erasure button is
  // the specific attack this closes.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Screenshot URLs are presigned S3 links with a 300-second life. A full referrer would leak the
  // signature into the logs of anything the browser subsequently talks to.
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  {
    key: 'Permissions-Policy',
    // Stated explicitly rather than left to the default, because "this product does not use your
    // camera or microphone" is a promise the agent makes and the dashboard should not quietly
    // contradict.
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Screenshots are fetched from S3 through short-lived presigned URLs, so the host is not known at
  // build time. next/image would need a remotePatterns entry per deployment; a plain <img> with an
  // explicit width and height is simpler and avoids proxying an image of somebody's screen through
  // the Next.js server.
  images: { unoptimized: true },

  // Next requires a promise-returning `headers`, and there is nothing to await — written without
  // `async` so the lint rule that catches genuinely pointless async functions keeps working.
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }]);
  },

  eslint: {
    // Linting runs as its own CI job; duplicating it inside the build only slows the build down.
    ignoreDuringBuilds: true,
  },
};

export default config;
