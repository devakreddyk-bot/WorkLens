'use client';

/**
 * The day control: which date the page is about.
 *
 * A Client Component because it is one of the few genuine interactions in the product — everything
 * else on these pages is a document. It writes the date into the URL rather than into state, so a
 * particular day is a link somebody can send to the person they want to talk about it with, and the
 * back button walks back through the days they looked at.
 *
 * Other search parameters are carried through. On the employee record the day and the day/week view
 * are separate parameters, and changing one must not silently reset the other.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { shiftDate, todayIn } from '@/lib/dates';
import { formatLongDate } from '@/lib/format';

import { quietButtonClass } from './Fields';

export function DateNav({
  date,
  /**
   * The zone "today" is measured in — the employee's on their record, the organisation's on the team
   * view. Never the viewer's: a manager in Melbourne pressing Today for an Indian colleague at 08:00
   * local would otherwise land on tomorrow.
   */
  timezone,
  label = 'Day',
}: {
  date: string;
  timezone: string;
  label?: string;
}): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function go(next: string): void {
    const query = new URLSearchParams(params.toString());
    query.set('date', next);
    router.push(`${pathname}?${query.toString()}`);
  }

  const today = todayIn(timezone);

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2" data-print="hide">
      <div>
        <label className="label block" htmlFor="date-nav">
          {label}
        </label>
        <input
          id="date-nav"
          type="date"
          value={date}
          max={today}
          onChange={(event) => {
            if (event.target.value !== '') go(event.target.value);
          }}
          className="figure mt-1.5 border border-rule-strong bg-slip px-2.5 py-1.5 text-[0.9rem] text-ink"
        />
      </div>

      <div className="flex items-center gap-2">
        <button type="button" className={quietButtonClass} onClick={() => go(shiftDate(date, -1))}>
          Earlier
        </button>
        <button
          type="button"
          className={quietButtonClass}
          onClick={() => go(shiftDate(date, 1))}
          /* Tomorrow has not happened. A page of zeroes for a future date is not a fact about
             anybody's work, and offering the button implies there might be something there. */
          disabled={date >= today}
        >
          Later
        </button>
        <button type="button" className={quietButtonClass} onClick={() => go(today)} disabled={date === today}>
          Today
        </button>
      </div>

      <p className="figure pb-1.5 text-[0.8125rem] text-ink-faint">{formatLongDate(date)}</p>
    </div>
  );
}
