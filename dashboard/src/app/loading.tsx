/**
 * The loading state.
 *
 * Ruled lines rather than a spinner or a shimmer. Every page in this product is a register, and a
 * register that is still being filled in looks like an empty register — the columns are already there
 * and the rows are not. A pulsing grey block would be the first floating, animated element in a design
 * that is otherwise flat and still.
 *
 * `aria-hidden` on the lines, with the status in text: there is nothing in the ruling for a screen
 * reader to read, and "Loading" said once is better than eight blank rows announced individually.
 */
export default function Loading(): React.ReactElement {
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <p role="status" className="label text-ink-faint">
        Loading the register
      </p>

      <div aria-hidden="true" className="mt-4 border border-rule-strong bg-slip">
        <div className="border-b border-rule-strong px-3 py-2.5">
          <span className="block h-2 w-40 bg-rule" />
        </div>
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            data-band={index % 2 === 1 ? 'true' : 'false'}
            className={`flex items-center gap-6 border-b border-rule px-3 py-3 last:border-b-0 ${index % 2 === 1 ? 'bg-band' : ''}`}
          >
            <span className="block h-2 w-32 bg-rule" />
            <span className="block h-2 flex-1 bg-rule/60" />
            <span className="block h-2 w-16 bg-rule" />
          </div>
        ))}
      </div>
    </div>
  );
}
