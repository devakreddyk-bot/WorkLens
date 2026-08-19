'use client';

/**
 * The CSV download.
 *
 * # Why the file is assembled in the browser
 *
 * The export route returns the CSV **base64-encoded inside a JSON envelope**, not as `text/csv`.
 * `backend/src/shared/http.ts` serialises every response body with `JSON.stringify`, so a raw CSV body
 * is not expressible through the shared wrapper — a real `text/csv` response would need a raw-response
 * branch in its `toProxyResult`. Base64 is what keeps the byte-order mark and the CRLF line endings
 * byte-exact through a JSON transport, which is what Excel needs to open the file without mangling it.
 *
 * So the bytes are decoded here and handed to the browser as a Blob. The alternative — a link straight
 * to the API — would also mean putting an access token in a URL.
 *
 * # Why it is a button and not a link
 *
 * The export is audited before a single row is read: it is a bulk read of every monitored person's
 * hours. It should appear in the access log when somebody asked for the file, not when they opened the
 * page, and a link that a browser might prefetch cannot promise that.
 */

import { useState, useTransition } from 'react';

import { exportCsv } from '@/lib/actions';

import { buttonClass } from './Fields';

/**
 * base64 to bytes. `atob` gives one character per byte; the loop is what turns them into bytes.
 *
 * The buffer is allocated first and the view taken from it, rather than the other way round, so the
 * type is an `ArrayBuffer`-backed view — `Blob` will not accept a view over a possibly-shared buffer.
 */
function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

export function ExportButton({
  from,
  to,
  employeeId,
  employeeName,
}: {
  from: string;
  to: string;
  employeeId: string | null;
  employeeName: string | null;
}): React.ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function download(): void {
    setFailure(null);
    setMessage(null);

    startTransition(() => {
      void (async () => {
        const result = await exportCsv(from, to, employeeId);
        if (result.status === 'error') {
          setFailure(result.message);
          return;
        }

        const envelope = result.value;
        const blob = new Blob([decodeBase64(envelope.content)], { type: envelope.content_type });
        const url = URL.createObjectURL(blob);

        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = envelope.filename;
        anchor.click();
        // Released immediately: the click has already handed the blob to the download, and holding the
        // URL keeps a copy of every employee's hours alive in the tab's memory.
        URL.revokeObjectURL(url);

        setMessage(
          `${envelope.filename} — ${envelope.row_count} ${envelope.row_count === 1 ? 'row' : 'rows'}, ${Math.max(1, Math.round(envelope.byte_count / 1024))} KB.`,
        );
      })();
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className={buttonClass} onClick={download} disabled={pending}>
          {pending ? 'Preparing' : 'Download CSV'}
        </button>
        <p className="text-[0.8125rem] text-ink-soft">
          {employeeName === null
            ? 'One row per employee per day, for everyone.'
            : `One row per day for ${employeeName}.`}{' '}
          Downloading is recorded in the access log.
        </p>
      </div>

      {message !== null && (
        <p role="status" className="mt-3 border-l-2 border-active bg-band px-3 py-2 text-[0.875rem]">
          {message}
        </p>
      )}
      {failure !== null && (
        <p role="alert" className="mt-3 border-l-2 border-flag bg-flag-soft px-3 py-2 text-[0.875rem]">
          {failure}
        </p>
      )}
    </div>
  );
}
