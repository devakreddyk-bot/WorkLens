'use client';

/**
 * The CSV download.
 *
 * # Why the file still passes through the browser
 *
 * The export route returns a real `text/csv` body now, so there is no envelope to decode — this used
 * to hold a base64 decoder for exactly that. The bytes are still assembled into a Blob here rather
 * than fetched by a plain link, for a reason that has nothing to do with encoding: the API requires
 * a bearer token that client JavaScript never holds. An `<a href>` straight to the export would be
 * unauthenticated, and the alternative — putting an access token in a URL — writes a credential into
 * browser history and into every log between here and the API.
 *
 * The Blob is built from the text with an explicit UTF-8 type. The byte-order mark arrives as a
 * `U+FEFF` character at the start of the string and is encoded back to `EF BB BF`, which is what lets
 * Excel open the file without mangling an accented name.
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

        const file = result.value;
        const blob = new Blob([file.content], { type: file.contentType });
        const url = URL.createObjectURL(blob);

        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.filename;
        anchor.click();
        // Released immediately: the click has already handed the blob to the download, and holding the
        // URL keeps a copy of every employee's hours alive in the tab's memory.
        URL.revokeObjectURL(url);

        // Row and byte counts came from the old JSON envelope and are no longer sent — the response
        // is the file itself. Reporting the size the browser actually received is more honest than
        // reporting a number the server computed about bytes it hoped to send.
        const kb = Math.max(1, Math.round(blob.size / 1024));
        setMessage(`${file.filename} — ${kb} KB.`);
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
