'use client';

/**
 * The error boundary.
 *
 * Every page in this dashboard is one API call away from a refusal, and most of the refusals are
 * legitimate: a manager reaching an owner-only page, a range the API will not scan, an employee id that
 * belongs to another organisation. So this does not apologise and it does not say "something went
 * wrong" — it states what happened, in the API's own words where there are any, and what to do next.
 *
 * The reference is the API's request id where the message carried one, and Next's digest otherwise.
 * Both appear in the deployment's logs against the same request, which is the one thing whoever
 * administers this can actually act on.
 */

import Link from 'next/link';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <div className="mx-auto max-w-[46rem] px-6 py-16">
      <p className="label text-flag">This page did not load</p>
      <h1 className="mt-2 text-[1.9rem] leading-tight tracking-tight">
        The record could not be read
      </h1>

      <div className="mt-6 border-t border-rule pt-6">
        {/* The server's message, not a paraphrase of it. "Two-factor authentication is required" and
            "range must not exceed 400 days" are both actionable; a generic sentence is not. */}
        <p className="text-[1.05rem] leading-relaxed text-ink">{error.message}</p>

        <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-soft">
          If you followed a link to somebody else&rsquo;s record, your account may not cover it. If you were
          reading your own, try again — and if it keeps failing, send the reference below to whoever
          administers this deployment.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button
          type="button"
          onClick={reset}
          className="label border border-ink bg-ink px-5 py-2.5 text-paper transition-colors hover:border-active hover:bg-active"
        >
          Try again
        </button>
        <Link href="/" className="label underline decoration-rule underline-offset-4 hover:text-ink">
          Back to the start
        </Link>
        <Link href="/me" className="label underline decoration-rule underline-offset-4 hover:text-ink">
          My own record
        </Link>
      </div>

      {error.digest !== undefined && (
        <p className="figure mt-12 border-t border-rule pt-4 text-[0.8125rem] text-ink-faint">
          Reference {error.digest}
        </p>
      )}
    </div>
  );
}
