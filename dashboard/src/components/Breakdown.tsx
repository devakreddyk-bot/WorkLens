/**
 * A "where the time went" table: applications, sites, categories, projects.
 *
 * Four of these appear side by side on an employee's day, and they are one component because they are
 * one kind of thing — a label and a duration, longest first.
 *
 * ## No percentages
 *
 * The obvious column here is "share of the day", and it is deliberately absent. A percentage invites
 * the reading that some of the shares are the good ones, which is the productivity score this product
 * does not compute and must not imply. The bar behind each row is proportional to the *longest row*,
 * not to the day, so it is a scanning aid for ordering rather than a claim about how a day should have
 * been divided.
 */

import { formatDuration } from '@/lib/format';

import { Empty, Register, RegisterHead, Th, Tr, Td } from './Register';

export interface BreakdownItem {
  label: string;
  seconds: number;
}

export function Breakdown({
  heading,
  columnLabel,
  rows,
  /** Says which kind of empty this is. "Nothing recorded" and "not collected" are different facts. */
  empty,
  limit = 8,
}: {
  heading: string;
  columnLabel: string;
  rows: readonly BreakdownItem[];
  empty: React.ReactNode;
  limit?: number;
}): React.ReactElement {
  const ordered = [...rows].sort((a, b) => b.seconds - a.seconds);
  const shown = ordered.slice(0, limit);
  const remainder = ordered.slice(limit);
  const longest = shown[0]?.seconds ?? 0;
  const remainderSeconds = remainder.reduce((total, row) => total + row.seconds, 0);

  return (
    <div>
      <h3 className="label mb-2 border-b border-rule pb-1.5">{heading}</h3>
      {shown.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <Register>
          <RegisterHead>
            <Th>{columnLabel}</Th>
            <Th numeric>Recorded</Th>
          </RegisterHead>
          <tbody>
            {shown.map((row, index) => (
              <Tr key={row.label} index={index}>
                <Td>
                  <span className="relative block">
                    {/* Behind the text rather than beside it, so the column stays a column of names.
                        Faint enough to be read past, which is the point of a scanning aid. */}
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-[-2px] left-0 bg-active/10"
                      style={{ width: longest === 0 ? '0%' : `${(row.seconds / longest) * 100}%` }}
                    />
                    <span className="relative">{row.label}</span>
                  </span>
                </Td>
                <Td numeric>{formatDuration(row.seconds)}</Td>
              </Tr>
            ))}
            {remainder.length > 0 && (
              <Tr index={shown.length}>
                <Td className="text-ink-faint">
                  {remainder.length} more, grouped
                </Td>
                <Td numeric className="text-ink-faint">
                  {formatDuration(remainderSeconds)}
                </Td>
              </Tr>
            )}
          </tbody>
        </Register>
      )}
    </div>
  );
}

/** Adds up breakdown entries that share a label, for a week's worth of days. */
export function mergeBreakdown(groups: readonly (readonly BreakdownItem[])[]): BreakdownItem[] {
  const totals = new Map<string, number>();
  for (const group of groups) {
    for (const row of group) {
      totals.set(row.label, (totals.get(row.label) ?? 0) + row.seconds);
    }
  }
  return [...totals].map(([label, seconds]) => ({ label, seconds }));
}
