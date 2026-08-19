import Link from 'next/link';

/**
 * The settings sub-navigation.
 *
 * Four pages that are one subject, so they get a shared row of labels rather than four unrelated
 * destinations reachable only from the masthead. Styled as the masthead's navigation is — labels and a
 * rule, not pills — because it is the same kind of thing one level down.
 */
const PAGES: readonly { href: string; label: string }[] = [
  { href: '/settings/monitoring', label: 'Monitoring' },
  { href: '/settings/users', label: 'Users' },
  { href: '/settings/devices', label: 'Devices' },
  { href: '/settings/data', label: 'Data' },
];

export function SettingsNav({ current }: { current: string }): React.ReactElement {
  return (
    <nav aria-label="Settings" className="border-b border-rule" data-print="hide">
      <ul className="-mb-px flex flex-wrap gap-x-6">
        {PAGES.map((page) => (
          <li key={page.href}>
            <Link
              href={page.href}
              aria-current={page.href === current ? 'page' : undefined}
              className={
                page.href === current
                  ? 'label block border-b-2 border-ink py-2.5 text-ink'
                  : 'label block border-b-2 border-transparent py-2.5 hover:border-rule-strong hover:text-ink'
              }
            >
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
