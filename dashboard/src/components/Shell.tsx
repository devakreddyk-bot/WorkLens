import Link from 'next/link';

import type { Session } from '@/lib/session';
import { isAdmin, needsMfaEnrolment } from '@/lib/session';

/**
 * The register's masthead and navigation.
 *
 * Styled as a document header rather than an app chrome: a rule under the title, the organisation and
 * the period stated as a form states them, and the navigation as a row of labels rather than pills. A
 * dashboard's sidebar implies a tool you operate; a masthead implies a document you read, which is the
 * position this product takes.
 *
 * The navigation renders only what this session may reach. That is presentation, not enforcement —
 * `backend/src/middleware/cognitoAuth.ts` refuses regardless — but offering a link that will be
 * refused is a small dishonesty the interface can avoid.
 */
export function Shell({
  session,
  employeeName,
  organisationName,
  children,
}: {
  session: Session;
  employeeName: string | null;
  organisationName: string;
  children: React.ReactNode;
}): React.ReactElement {
  const admin = isAdmin(session);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-rule-strong bg-slip">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-baseline justify-between gap-x-8 gap-y-2 px-6 pt-5 pb-3">
          <div className="flex items-baseline gap-4">
            <Link href="/" className="font-display text-[1.35rem] leading-none font-700 tracking-tight">
              WorkLens
            </Link>
            <span className="label">{organisationName}</span>
          </div>

          <div className="flex items-baseline gap-5" data-print="hide">
            <span className="label">
              {employeeName ?? session.email}
              <span className="ml-2 text-ink-faint">{roleLabel(session.role)}</span>
            </span>
            {/* A form post, not a link: signing out has an effect, and a GET that changes state can be
                triggered by a prefetch. */}
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="label underline decoration-rule underline-offset-4 hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>

        <nav aria-label="Sections" className="mx-auto max-w-[1400px] px-6" data-print="hide">
          <ul className="-mb-px flex flex-wrap gap-x-6">
            {admin && <NavItem href="/overview" label="Overview" />}
            {admin && <NavItem href="/team" label="Team" />}
            <NavItem href="/me" label={admin ? 'My record' : 'My timesheet'} />
            {admin && <NavItem href="/reports" label="Reports" />}
            {session.role === 'owner' && <NavItem href="/projects" label="Projects" />}
            {session.role === 'owner' && <NavItem href="/settings/monitoring" label="Settings" />}
            {session.role === 'owner' && <NavItem href="/audit-log" label="Access log" />}
          </ul>
        </nav>
      </header>

      {needsMfaEnrolment(session) && <MfaBanner />}

      <main id="register" className="mx-auto max-w-[1400px] px-6 py-8">
        {children}
      </main>
    </div>
  );
}

function NavItem({ href, label }: { href: string; label: string }): React.ReactElement {
  return (
    <li>
      <Link
        href={href}
        className="label block border-b-2 border-transparent py-3 hover:border-rule-strong hover:text-ink"
      >
        {label}
      </Link>
    </li>
  );
}

function roleLabel(role: Session['role']): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'manager':
      return 'Manager';
    default:
      return 'Employee';
  }
}

/**
 * The MFA notice.
 *
 * Persistent and unmissable, because until it is resolved every administrative page will refuse to
 * load — an admin who does not know why would reasonably conclude the product is broken. It states
 * the consequence rather than the rule: "you cannot see other people's records" is what they are
 * experiencing, whereas "MFA is required" is a policy they have to translate.
 */
function MfaBanner(): React.ReactElement {
  return (
    <div className="border-b border-flag/40 bg-flag-soft" data-print="hide">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-baseline gap-x-3 gap-y-1 px-6 py-3">
        <span className="label text-flag">Set up two-factor authentication</span>
        <p className="text-[0.875rem] text-ink-soft">
          Until you do, you can only see your own record. Other people&rsquo;s timesheets, settings and
          the access log will not load.
        </p>
        <Link
          href="/mfa-required"
          className="label text-flag underline decoration-flag/40 underline-offset-4 hover:decoration-flag"
        >
          How to set it up
        </Link>
      </div>
    </div>
  );
}
