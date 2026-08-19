import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getSession } from '@/lib/session';

export const metadata = { title: 'Sign in' };

/**
 * Sign-in.
 *
 * The page states what the product is before asking anyone to sign in, because on a shared machine the
 * person reading it may be an employee who has never seen it before and did not choose to install it.
 * A bare logo and a button would tell them nothing.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}): Promise<React.ReactElement> {
  // Already signed in: send them on rather than showing a button that immediately bounces.
  if ((await getSession()) !== null) {
    redirect('/');
  }

  const { reason } = await searchParams;
  const notice = reasonNotice(reason);

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="mx-auto flex w-full max-w-[52rem] flex-1 flex-col justify-center px-6 py-16">
        <p className="label">Time and activity records</p>
        <h1 className="mt-2 text-[2.6rem] leading-[1.05] tracking-tight">WorkLens</h1>

        <div className="mt-6 max-w-[38rem] border-t border-rule pt-6">
          <p className="text-[1.05rem] leading-relaxed text-ink-soft">
            Timesheets built from what actually happened on a work computer, so nobody has to
            reconstruct their week from memory.
          </p>

          {/* Stated on the sign-in page rather than buried in a policy document. An employee arriving
              here should be able to learn what this is before they authenticate to it. */}
          <dl className="mt-6 space-y-2.5 text-[0.9rem]">
            <div className="flex gap-3">
              <dt className="label w-28 shrink-0 pt-0.5">Records</dt>
              <dd className="text-ink-soft">
                The application in use, active and idle time, and — where the organisation has enabled
                it — window titles and periodic screenshots.
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="label w-28 shrink-0 pt-0.5">Never</dt>
              <dd className="text-ink-soft">
                What you type, your passwords, your clipboard, your camera or your microphone. The
                software contains no ability to.
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="label w-28 shrink-0 pt-0.5">Yours too</dt>
              <dd className="text-ink-soft">
                Every employee can sign in and see their own record, in the same detail their manager
                sees it.
              </dd>
            </div>
          </dl>
        </div>

        {notice !== null && (
          <p
            role="status"
            className="mt-8 max-w-[38rem] border-l-2 border-flag bg-flag-soft px-4 py-3 text-[0.9rem] text-ink"
          >
            {notice}
          </p>
        )}

        <div className="mt-10">
          <Link
            href="/api/auth/login"
            className="label inline-block border border-ink bg-ink px-6 py-3 text-paper transition-colors hover:bg-active hover:border-active"
          >
            Sign in
          </Link>
          <p className="mt-3 text-[0.8125rem] text-ink-faint">
            You will be taken to your organisation&rsquo;s sign-in page.
          </p>
        </div>
      </div>

      <footer className="border-t border-rule px-6 py-4">
        <p className="label mx-auto max-w-[52rem] text-ink-faint">
          Questions about what is recorded should go to whoever administers this deployment.
        </p>
      </footer>
    </div>
  );
}

/**
 * Turns a redirect reason into something worth reading.
 *
 * Every one of these says what happened and what to do. "state-mismatch" is meaningless to the person
 * reading it, and the honest translation is that the attempt could not be verified and should be
 * repeated — which is both true and actionable.
 */
function reasonNotice(reason: string | undefined): string | null {
  switch (reason) {
    case 'expired':
      return 'Your session has ended. Sign in again to continue.';
    case 'signed-out':
      return 'You have been signed out.';
    case 'cancelled':
      return 'Sign-in was cancelled.';
    case 'state-mismatch':
    case 'no-code':
      return 'That sign-in attempt could not be verified. Please start again.';
    case 'exchange-failed':
    case 'provider-error':
      return 'Sign-in did not complete. Try again, and if it keeps happening contact whoever administers this deployment.';
    default:
      return null;
  }
}
