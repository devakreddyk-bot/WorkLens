import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getSession, needsMfaEnrolment } from '@/lib/session';

export const metadata = { title: 'Two-factor authentication' };

/**
 * The forced-enrolment page for an admin without a second factor.
 *
 * A page and not a modal, deliberately. The API refuses every administrative route with
 * `MFA_REQUIRED`, and the client redirects here — so this has to be a real destination with a URL,
 * reachable when every other admin page is not. It is also why `/v1/me` is the one route the server
 * leaves ungated: without it, the shell that renders this page could not load either.
 */
export default async function MfaRequiredPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (session === null) {
    redirect('/login');
  }

  // Already enrolled, or an employee who was never gated. Nothing to do here, so do not leave them on
  // a page telling them to fix something that is not broken.
  if (!needsMfaEnrolment(session)) {
    redirect('/');
  }

  return (
    <div className="mx-auto max-w-[46rem] px-6 py-16">
      <p className="label text-flag">Action required</p>
      <h1 className="mt-2 text-[2rem] leading-tight tracking-tight">
        Set up two-factor authentication
      </h1>

      <div className="mt-6 border-t border-rule pt-6">
        <p className="text-[1.05rem] leading-relaxed text-ink-soft">
          Your account can see other people&rsquo;s timesheets, their activity and — if the organisation
          has enabled them — screenshots of their screens. That access needs a second factor before it
          will work.
        </p>
        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-soft">
          Until then you can still see your own record. Everything else will refuse to load, which is
          the gate working rather than a fault.
        </p>
      </div>

      {/* Numbered because this genuinely is a sequence: each step depends on the one before it. The
          register does not otherwise number things. */}
      <ol className="mt-8 space-y-5">
        <Step n={1} title="Open your organisation's sign-in page">
          Sign out and sign in again. On the sign-in page, choose the option to set up an authenticator
          app.
        </Step>
        <Step n={2} title="Scan the code with an authenticator app">
          Any TOTP app will do — Microsoft Authenticator, Google Authenticator, 1Password, Authy. There
          is nothing to install on your work computer.
        </Step>
        <Step n={3} title="Enter the six-digit code">
          Once it is accepted, sign in again here and the rest of the dashboard will load.
        </Step>
      </ol>

      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="label border border-ink bg-ink px-5 py-2.5 text-paper transition-colors hover:border-active hover:bg-active"
          >
            Sign out and set it up
          </button>
        </form>
        <Link href="/me" className="label underline decoration-rule underline-offset-4 hover:text-ink">
          See my own record instead
        </Link>
      </div>

      <p className="mt-12 border-t border-rule pt-4 text-[0.8125rem] text-ink-faint">
        If the sign-in page does not offer an authenticator option, whoever administers this deployment
        needs to enable software tokens on the Cognito user pool.
      </p>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <li className="flex gap-4">
      <span className="figure shrink-0 text-[0.9rem] text-ink-faint">{String(n).padStart(2, '0')}</span>
      <div>
        <h2 className="text-[1rem] leading-snug">{title}</h2>
        <p className="mt-1 text-[0.9rem] text-ink-soft">{children}</p>
      </div>
    </li>
  );
}
