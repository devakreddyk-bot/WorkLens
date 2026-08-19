import { redirect } from 'next/navigation';

import { getSession } from '@/lib/session';

/**
 * The root sends a signed-in person to the view that is theirs.
 *
 * An owner or manager lands on the overview; an employee lands on their own record. Deciding here
 * rather than showing a chooser means nobody is ever presented with a link to a page they will be
 * refused, which is both kinder and one fewer place for the UI's idea of a role to drift from the
 * server's.
 */
export default async function RootPage(): Promise<never> {
  const session = await getSession();

  if (session === null) {
    redirect('/login');
  }

  if (session.role === 'employee') {
    redirect('/me');
  }

  redirect('/overview');
}
