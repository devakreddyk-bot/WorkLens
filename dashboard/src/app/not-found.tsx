import Link from 'next/link';

export const metadata = { title: 'Not found' };

/**
 * A URL with nothing behind it.
 *
 * Kept separate from the error boundary because it is a different fact and deserves different advice:
 * nothing failed, the address simply does not name anything. Employee records are addressed by
 * identifier, so the most likely cause is a link that outlived the record it pointed at.
 */
export default function NotFound(): React.ReactElement {
  return (
    <div className="mx-auto max-w-[46rem] px-6 py-16">
      <p className="label">Nothing here</p>
      <h1 className="mt-2 text-[1.9rem] leading-tight tracking-tight">That address does not name a record</h1>

      <div className="mt-6 border-t border-rule pt-6">
        <p className="text-[1.05rem] leading-relaxed text-ink-soft">
          Either the link was mistyped, or it pointed at something that has since been removed. Employee
          records keep the same address for as long as they exist, so a link that used to work and no
          longer does usually means the record was erased.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link
          href="/"
          className="label border border-ink bg-ink px-5 py-2.5 text-paper transition-colors hover:border-active hover:bg-active"
        >
          Back to the start
        </Link>
        <Link href="/me" className="label underline decoration-rule underline-offset-4 hover:text-ink">
          My own record
        </Link>
      </div>
    </div>
  );
}
