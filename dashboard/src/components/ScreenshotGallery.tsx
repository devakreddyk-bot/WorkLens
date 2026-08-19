'use client';

/**
 * The screenshot gallery.
 *
 * # It lists metadata and fetches nothing
 *
 * The page loads the time, the dimensions and the blur flag for each image. No URL is presigned until
 * somebody presses Open on a particular image, and there are two independent reasons for that:
 *
 *   1. A presigned URL lives 300 seconds. Presigning a day's worth on load produces a gallery whose
 *      every image is broken five minutes later — including the one the person was about to look at.
 *   2. The API writes the audit row *before* it issues the URL. Presigning speculatively would fill
 *      the access log with views of images nobody ever opened, which makes the log useless for the
 *      question it exists to answer.
 *
 * So the tile is a record, and opening it is an act. The interface says so, above the grid, in the
 * same words the audit entry will be written in.
 *
 * # The blur flag is on every tile
 *
 * Not only on the opened image. A viewer scanning a day has to be able to tell a blurred capture from
 * a legible one without opening either, because whether an image is legible is the whole difference
 * between the two privacy postures this setting offers.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';

import type { ScreenshotRow, ScreenshotUrlResponse } from '@/lib/api';
import { screenshotUrl } from '@/lib/actions';
import { formatLocalTime } from '@/lib/format';

import { Note, quietButtonClass } from './Fields';
import { Empty } from './Register';

interface OpenImage {
  meta: ScreenshotRow;
  view: ScreenshotUrlResponse;
  /** Epoch milliseconds at which the presigned URL stops working. */
  expiresAt: number;
}

export function ScreenshotGallery({
  employeeId,
  timezone,
  screenshots,
  self,
}: {
  employeeId: string;
  timezone: string;
  screenshots: readonly ScreenshotRow[];
  self: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState<OpenImage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  /* The URL genuinely stops working, so the viewer is cleared when it does rather than left showing a
     broken image. An expired link that looks like a missing screenshot is the kind of thing somebody
     reports as data loss. */
  useEffect(() => {
    if (open === null) return;
    const remaining = open.expiresAt - Date.now();
    if (remaining <= 0) {
      setOpen(null);
      return;
    }
    const timer = setTimeout(() => setOpen(null), remaining);
    return () => clearTimeout(timer);
  }, [open]);

  const load = useCallback(
    (meta: ScreenshotRow) => {
      setFailure(null);
      setPendingId(meta.id);
      startTransition(() => {
        void (async () => {
          const result = await screenshotUrl(employeeId, meta.id);
          setPendingId(null);
          if (result.status === 'error') {
            setFailure(result.message);
            return;
          }
          setOpen({
            meta,
            view: result.value,
            expiresAt: Date.now() + result.value.expires_in_seconds * 1000,
          });
          setOpened((previous) => new Set(previous).add(meta.id));
        })();
      });
    },
    [employeeId],
  );

  if (screenshots.length === 0) {
    return (
      <Empty>
        No screenshots for this day. Either none were captured, or this organisation does not have
        screenshot capture turned on.
      </Empty>
    );
  }

  return (
    <div>
      <Note tone="lens">
        {self
          ? 'Opening an image records that you looked at your own record. Nothing is fetched until you press Open.'
          : 'Opening an image records your name, which image and the time. Nothing is fetched until you press Open — an image you do not open does not appear in the access log.'}
      </Note>

      {failure !== null && (
        <p role="alert" className="mt-3 border-l-2 border-flag bg-flag-soft px-3 py-2 text-[0.875rem]">
          {failure}
        </p>
      )}

      {open !== null && (
        <figure className="mt-5 border border-rule-strong bg-slip">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="figure text-[0.9375rem]">{formatLocalTime(open.meta.captured_at, timezone)}</span>
              <span className="figure text-[0.8125rem] text-ink-faint">
                {open.meta.width}×{open.meta.height}
              </span>
              <BlurFlag blurred={open.meta.blurred} />
            </div>
            <button type="button" className="label underline decoration-rule underline-offset-4" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          {/* A plain <img>: the host is a presigned S3 URL that is not known at build time, and routing
              an image of somebody's screen through the Next.js server to optimise it would be a second
              copy of it in a second place. */}
          <img
            src={open.view.url}
            alt={`Screen capture at ${formatLocalTime(open.meta.captured_at, timezone)}${open.meta.blurred ? ', blurred' : ''}`}
            width={open.meta.width}
            height={open.meta.height}
            className="block h-auto w-full"
          />
          <figcaption className="border-t border-rule px-3 py-2 text-[0.8125rem] text-ink-soft">
            This image stops loading about {Math.round(open.view.expires_in_seconds / 60)} minutes after it
            was opened. Press Open again if it disappears.
          </figcaption>
        </figure>
      )}

      <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {screenshots.map((shot) => (
          <li key={shot.id} className="border border-rule bg-slip">
            <div className="flex items-baseline justify-between gap-3 border-b border-rule px-3 py-2">
              <span className="figure text-[0.9375rem]">{formatLocalTime(shot.captured_at, timezone)}</span>
              <BlurFlag blurred={shot.blurred} />
            </div>
            <dl className="px-3 py-2 text-[0.8125rem] text-ink-soft">
              <div className="flex justify-between gap-3">
                <dt className="label">Size</dt>
                <dd className="figure">
                  {shot.width}×{shot.height}
                </dd>
              </div>
              <div className="mt-1 flex justify-between gap-3">
                <dt className="label">Weight</dt>
                <dd className="figure">{Math.round(shot.byte_count / 1024)} KB</dd>
              </div>
            </dl>
            <div className="flex items-center justify-between gap-3 border-t border-rule px-3 py-2">
              <button
                type="button"
                className={quietButtonClass}
                onClick={() => load(shot)}
                disabled={pendingId === shot.id}
              >
                {pendingId === shot.id ? 'Opening' : 'Open'}
              </button>
              {opened.has(shot.id) && <span className="label text-ink-faint">recorded as viewed</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Whether the image was blurred before it left the machine.
 *
 * Both states are stated. An unlabelled image invites the assumption that it is blurred, and the
 * difference between a blurred capture and a legible one is the difference between knowing somebody was
 * in a document and being able to read it.
 */
function BlurFlag({ blurred }: { blurred: boolean }): React.ReactElement {
  return blurred ? (
    <span className="label border border-lens px-1.5 py-0.5 text-lens">Blurred</span>
  ) : (
    <span className="label border border-rule-strong px-1.5 py-0.5 text-ink-soft">Full detail</span>
  );
}
