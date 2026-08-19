/**
 * The register primitives: the table, its banding, its column labels.
 *
 * Extracted so every page's tables are the same table. The design's discipline lives in spacing and
 * hairlines rather than in colour or shadow, so the moment two pages set their own padding the whole
 * thing stops reading as one document.
 */

export function Register({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={`overflow-x-auto border border-rule-strong bg-slip ${className}`}>
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  );
}

export function RegisterHead({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <thead>
      <tr className="border-b border-rule-strong">{children}</tr>
    </thead>
  );
}

/**
 * A column label. `numeric` right-aligns and switches to mono, because a column of figures is read by
 * scanning the last digit and that only works when the digits line up.
 */
export function Th({
  children,
  numeric = false,
  className = '',
}: {
  children: React.ReactNode;
  numeric?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <th
      scope="col"
      className={`label px-3 py-2.5 align-bottom ${numeric ? 'text-right' : 'text-left'} ${className}`}
    >
      {children}
    </th>
  );
}

/**
 * A row. `index` drives the ledger banding — the alternating tint from accounting paper, which is
 * there to help the eye hold a line across a wide row rather than to decorate.
 */
export function Tr({
  index,
  children,
  className = '',
}: {
  index: number;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const banded = index % 2 === 1;
  return (
    <tr
      data-band={banded ? 'true' : 'false'}
      className={`border-b border-rule last:border-b-0 ${banded ? 'bg-band' : 'bg-slip'} ${className}`}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  numeric = false,
  className = '',
}: {
  children: React.ReactNode;
  numeric?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <td className={`px-3 py-2.5 align-middle ${numeric ? 'figure text-right' : ''} ${className}`}>
      {children}
    </td>
  );
}

/** A section heading, in the register's voice: a label, a rule, and the content. */
export function Section({
  label,
  title,
  aside,
  children,
}: {
  label: string;
  title?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-rule pb-2">
        <div>
          <p className="label">{label}</p>
          {title !== undefined && <h2 className="mt-0.5 text-[1.15rem] leading-tight">{title}</h2>}
        </div>
        {aside !== undefined && <div className="flex items-baseline gap-4">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * An empty state, written as an instruction rather than an apology.
 *
 * Emptiness is frequently the correct outcome in this product — outside work hours nothing is
 * recorded, and on a day off there is nothing to show — so these say which kind of empty it is.
 */
export function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="border border-dashed border-rule bg-slip px-6 py-10 text-center">
      <p className="text-[0.9rem] text-ink-soft">{children}</p>
    </div>
  );
}

/** A figure with its label beneath, for the summary strip. Mono, large, tabular. */
export function Figure({
  value,
  label,
  tone = 'ink',
}: {
  value: string;
  label: string;
  tone?: 'ink' | 'active' | 'idle' | 'flag';
}): React.ReactElement {
  const colour =
    tone === 'active' ? 'text-active' : tone === 'idle' ? 'text-ink-faint' : tone === 'flag' ? 'text-flag' : 'text-ink';
  return (
    <div>
      <p className={`figure text-[1.6rem] leading-none ${colour}`}>{value}</p>
      <p className="label mt-1.5">{label}</p>
    </div>
  );
}
