/**
 * CSV generation for the payroll export.
 *
 * Two hazards, both of which have bitten real timesheet exports, and both handled here rather
 * than left to the caller.
 *
 * ## The byte-order mark
 *
 * Excel on Windows opens a `.csv` in the system's legacy code page unless the file starts with a
 * UTF-8 BOM. Without it, `Kavyā Sundararājan` arrives as mojibake, and the person whose name it is
 * finds out by seeing it on their own payroll export. Three bytes at the front fix it, and no
 * standards-compliant reader minds them, so the BOM is not configurable.
 *
 * ## Formula injection
 *
 * A spreadsheet evaluates a cell beginning `=`, `+`, `-` or `@` as a formula, including forms that
 * reach the network or the shell (`=HYPERLINK(...)`, `=cmd|'/c calc'!A1` in older Excel). Employee
 * names, project names and window-derived text all originate as user input, so this is a live path
 * from "someone typed a name" to "code ran on the payroll clerk's laptop". Every such cell is
 * prefixed with a single quote, which spreadsheets treat as "the rest is text" and which readers
 * that do not evaluate formulas show verbatim.
 *
 * Applying the guard to *every* cell rather than only the text ones is safe here because no
 * legitimate value in this export starts with one of those characters: the numeric columns are
 * second counts, and `timesheets` constrains all of them to `>= 0`; the dates are ISO-8601; the
 * timestamps start with a digit. So there is no case where the guard would corrupt a number.
 *
 * ## "Streamed, not buffered"
 *
 * `encodeCsv` is an async generator over an async iterable of rows, and the row source
 * (`iterateExportRows`) is keyset-paginated — so peak memory is one page of rows plus one output
 * chunk, whatever the range. It never holds the export.
 *
 * What it cannot do is stream over the wire. API Gateway REST with a Lambda proxy integration has
 * no response streaming (that needs a Function URL and `awslambda.streamifyResponse`), so the last
 * step assembles the chunks. `collectCsv` therefore takes an explicit byte budget and refuses
 * rather than growing without limit — a 400 naming the limit is a far better answer to "export
 * five years" than an out-of-memory kill with no response at all. Keeping the encoder a generator
 * means moving to a streaming transport later is a change to the handler, not to this file.
 */

import { Readable } from 'node:stream';

import { AppError, ErrorCode } from '../shared/errors.js';

/** U+FEFF. Emitted as the first character; `Buffer.from(…, 'utf8')` encodes it as EF BB BF. */
export const UTF8_BOM = '\uFEFF';

/**
 * CRLF, which RFC 4180 specifies and which Excel needs to avoid treating the file as one long
 * line on some platforms. Readers that expect LF accept CRLF; the reverse is not reliable.
 */
const LINE_ENDING = '\r\n';

/** The characters a spreadsheet may treat as the start of a formula. */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@']);

/**
 * Tab and carriage return are included because Excel strips leading whitespace before deciding
 * whether a cell is a formula, so `"\t=1+1"` is evaluated just the same.
 */
const FORMULA_WHITESPACE_LEADERS = new Set(['\t', '\r']);

/** Renders one value as a CSV field: formula-guarded, then quoted if it needs to be. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  const raw = typeof value === 'number' ? String(value) : value;
  if (raw === '') return '';

  const first = raw.charAt(0);
  const guarded =
    FORMULA_LEADERS.has(first) || FORMULA_WHITESPACE_LEADERS.has(first) ? `'${raw}` : raw;

  // Quoting rules from RFC 4180, plus leading/trailing spaces: an unquoted field with those is
  // legal but readers disagree about whether to keep them, and a name is not the place to find out.
  const needsQuotes =
    guarded.includes(',') ||
    guarded.includes('"') ||
    guarded.includes('\n') ||
    guarded.includes('\r') ||
    guarded !== guarded.trim();

  if (!needsQuotes) return guarded;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** Joins pre-rendered cells into one record. */
export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map((cell) => csvCell(cell)).join(',') + LINE_ENDING;
}

/**
 * Characters of output accumulated before a chunk is yielded — an approximation of bytes, which is
 * all it needs to be: this is a buffer-size heuristic, and the exact byte count is measured where
 * it matters, in `collectCsv`.
 */
const CHUNK_TARGET_CHARS = 64 * 1024;

/**
 * Encodes a header and an async row source into CSV chunks.
 *
 * Chunked rather than yielding one string per row: a 90-day export for 50 people is 4 500 rows,
 * and 4 500 individually-yielded strings is 4 500 awaits through the generator machinery for no
 * benefit. Accumulating to ~64 KB first is the same output with two orders of magnitude fewer
 * iterations.
 */
export async function* encodeCsv(
  header: readonly string[],
  rows: AsyncIterable<readonly (string | number | null | undefined)[]>,
): AsyncGenerator<string, void, undefined> {
  let pending = UTF8_BOM + csvLine(header);

  for await (const row of rows) {
    pending += csvLine(row);
    if (pending.length >= CHUNK_TARGET_CHARS) {
      yield pending;
      pending = '';
    }
  }

  if (pending !== '') yield pending;
}

export interface CollectedCsv {
  body: Buffer;
  byteCount: number;
}

/**
 * Assembles the chunks, refusing to exceed `maxBytes`.
 *
 * The cap is checked as the chunks arrive rather than at the end, so an oversized export is
 * abandoned on the chunk that crosses the line instead of after the whole thing has been built.
 * The error is a 413 with the limit in the message, which tells the caller the actionable thing:
 * narrow the range or the employee.
 */
export async function collectCsv(
  chunks: AsyncIterable<string>,
  maxBytes: number,
): Promise<CollectedCsv> {
  const parts: Buffer[] = [];
  let byteCount = 0;

  for await (const chunk of chunks) {
    const buffer = Buffer.from(chunk, 'utf8');
    byteCount += buffer.byteLength;

    if (byteCount > maxBytes) {
      throw new AppError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `This export exceeds the ${maxBytes}-byte response limit. Narrow the date range, or ` +
          `export one employee at a time.`,
        { logContext: { maxBytes } },
      );
    }

    parts.push(buffer);
  }

  return { body: Buffer.concat(parts), byteCount };
}

/**
 * The same encoder as a Node stream.
 *
 * Not used by the Lambda handler, which has nowhere to stream to (see the note at the top), and
 * kept deliberately: it is the seam a Function-URL variant or a "write the export to S3" job would
 * attach to, and having it here is what keeps `encodeCsv` honest about being a generator rather
 * than an array builder with extra steps.
 */
export function csvStream(
  header: readonly string[],
  rows: AsyncIterable<readonly (string | number | null | undefined)[]>,
): Readable {
  return Readable.from(encodeCsv(header, rows), { encoding: 'utf8' });
}
