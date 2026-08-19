/**
 * What every page does before it renders anything.
 *
 * The masthead needs the person's name and the organisation's, and both come from `/me`. Fetching it
 * here means one call per page rather than one per component, and it means no page has to remember
 * that a session cookie without a live token is a redirect rather than an error.
 *
 * It makes no authorisation decision. A manager who navigates to an owner-only page gets a 403 from
 * the API and the error boundary says so — which is the truth, and one fewer place for the
 * dashboard's idea of a role to drift from the server's.
 */

import { redirect } from 'next/navigation';

import type { Me } from './api';
import { fetchMe } from './api';
import type { Session } from './session';
import { getSession } from './session';

export interface PageContext {
  session: Session;
  me: Me;
  /** The employee's own zone where there is one, otherwise the organisation's. */
  timezone: string;
}

export async function loadPage(): Promise<PageContext> {
  const session = await getSession();
  if (session === null) {
    redirect('/login');
  }

  const me = await fetchMe();

  return {
    session,
    me,
    timezone: me.employee?.timezone ?? me.organization.timezone,
  };
}

/** The masthead's props, spread into `<Shell>` so no page assembles them differently. */
export function shellProps(context: PageContext): {
  session: Session;
  employeeName: string | null;
  organisationName: string;
} {
  return {
    session: context.session,
    employeeName: context.me.employee?.full_name ?? null,
    organisationName: context.me.organization.name,
  };
}
