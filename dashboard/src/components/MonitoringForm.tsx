'use client';

/**
 * The monitoring configuration.
 *
 * This is the page where the product's posture is either honest or it isn't. Everything an owner can
 * change here changes what is taken off somebody else's laptop, and two rules follow from that:
 *
 *   1. **Every setting states its consequence inline**, next to the control, in the interface's own
 *      words. Not in a help centre, not in a tooltip. Turning on screenshots is not a switch like any
 *      other, and the interface should not present it as one.
 *   2. **Nothing saves without a diff.** Pressing Review shows exactly what is changing, from what to
 *      what, and the sentences that matter — "this will start collecting images of every screen" — are
 *      stated again there rather than assumed to have been read the first time.
 *
 * The whole object is submitted as one field, so what the dialog showed and what the API receives are
 * the same value. `PUT /v1/config` is a full replacement for the same reason: a partial update would
 * let somebody change screenshot capture without ever seeing the exclusion list that ships alongside
 * it, and "I didn't realise that was still on" is not an acceptable outcome on this page.
 */

import { useActionState, useMemo, useState } from 'react';

import type { MonitoringConfig, MonitoringConfigSaved } from '@/lib/api';
import type { FormState } from '@/lib/action-result';
import { IDLE } from '@/lib/action-result';
import { saveMonitoringConfig } from '@/lib/actions';
import { WEEKDAY_NAMES } from '@/lib/dates';

import { SubmitButton } from './ActionForm';
import { ActionNotice, Field, Switch, buttonClass, figureInputClass, inputClass, quietButtonClass } from './Fields';
import { Section } from './Register';

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

interface Change {
  key: keyof MonitoringConfig;
  label: string;
  from: string;
  to: string;
  /**
   * What this particular change will do, stated in the confirmation rather than only beside the
   * control. Present only for the changes that alter what is collected from a person's machine.
   */
  consequence?: string;
}

/** Every field's name as this page says it. Also the order the diff is listed in. */
const FIELD_LABELS: Readonly<Record<keyof MonitoringConfig, string>> = {
  sample_interval_seconds: 'Sampling interval',
  idle_threshold_seconds: 'Idle after',
  capture_window_titles: 'Window titles',
  capture_urls: 'Web addresses',
  screenshot_enabled: 'Screenshots',
  screenshot_interval_seconds: 'Screenshot interval',
  screenshot_blur: 'Blur screenshots',
  work_hours_only: 'Record during work hours only',
  work_hours_start: 'Work hours start',
  work_hours_end: 'Work hours end',
  work_days: 'Working days',
  excluded_apps: 'Excluded applications',
  excluded_url_patterns: 'Excluded addresses',
  retention_days_events: 'Keep activity for',
  retention_days_screenshots: 'Keep screenshots for',
};

function showValue(key: keyof MonitoringConfig, config: MonitoringConfig): string {
  const value = config[key];
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    if (key === 'work_days') return (value as number[]).map((day) => WEEKDAY_NAMES[day] ?? String(day)).join(', ');
    return `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`;
  }
  if (key === 'sample_interval_seconds' || key === 'idle_threshold_seconds' || key === 'screenshot_interval_seconds') {
    return `${String(value)} seconds`;
  }
  if (key === 'retention_days_events' || key === 'retention_days_screenshots') {
    return `${String(value)} days`;
  }
  return String(value);
}

/**
 * The sentences that exist for the confirmation and nowhere else.
 *
 * Keyed on the *transition*, not the setting: turning window titles on is a different fact from
 * turning them off, and only one of the two needs to be spelled out before somebody agrees to it.
 */
function consequenceOf(
  key: keyof MonitoringConfig,
  before: MonitoringConfig,
  after: MonitoringConfig,
): string | undefined {
  switch (key) {
    case 'screenshot_enabled':
      return after.screenshot_enabled
        ? `Every monitored machine will start taking an image of the whole screen every ${after.screenshot_interval_seconds} seconds${after.screenshot_blur ? ', blurred before it is uploaded' : ', in full readable detail'}.`
        : 'Machines will stop taking images. Images already collected are kept until their retention window ends.';
    case 'screenshot_blur':
      return after.screenshot_blur
        ? 'Images will be blurred on the machine before upload, so text in them is not readable.'
        : 'Images will be uploaded in full detail. Anything readable on screen becomes readable to whoever opens the gallery.';
    case 'capture_window_titles':
      return after.capture_window_titles
        ? 'The title of the window in front will be recorded. A title can name a document, a client or a diagnosis.'
        : 'Titles will no longer be recorded — only the application name.';
    case 'capture_urls':
      return after.capture_urls
        ? 'The host of the page open in a browser will be recorded, for example news.example.com.'
        : 'Web addresses will no longer be recorded at all.';
    case 'work_hours_only':
      return after.work_hours_only
        ? 'Outside the working window nothing is recorded — no time, no titles, no images.'
        : 'Recording will no longer stop outside working hours. Evenings and weekends will be recorded.';
    case 'excluded_apps':
      return 'Applications on this list are not recorded at all, including their time.';
    case 'excluded_url_patterns':
      return 'Pages matching this list are not recorded at all.';
    case 'retention_days_events':
      return after.retention_days_events > before.retention_days_events
        ? 'Activity records will be kept longer before automatic deletion.'
        : 'Activity records older than the new window are deleted at the next sweep, and cannot be recovered.';
    case 'retention_days_screenshots':
      return after.retention_days_screenshots > before.retention_days_screenshots
        ? 'Screenshots will be kept longer before automatic deletion.'
        : 'Screenshots older than the new window are deleted at the next sweep, and cannot be recovered.';
    default:
      return undefined;
  }
}

function diffConfig(before: MonitoringConfig, after: MonitoringConfig): Change[] {
  const changes: Change[] = [];
  for (const key of Object.keys(FIELD_LABELS) as (keyof MonitoringConfig)[]) {
    // Compared as JSON so the array fields are compared by content. The lists are short and ordered
    // the way they were typed, so a reorder counts as a change — which it is, for rule priority.
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    const consequence = consequenceOf(key, before, after);
    changes.push({
      key,
      label: FIELD_LABELS[key],
      from: showValue(key, before),
      to: showValue(key, after),
      ...(consequence === undefined ? {} : { consequence }),
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Text-area lists
// ---------------------------------------------------------------------------

/** One entry per line, blanks dropped. A comma-separated field cannot hold a pattern with a comma. */
function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export function MonitoringForm({
  config,
  configVersion,
}: {
  config: MonitoringConfig;
  configVersion: number;
}): React.ReactElement {
  const [draft, setDraft] = useState<MonitoringConfig>(config);
  const [reviewing, setReviewing] = useState(false);
  const [state, dispatch] = useActionState<FormState<MonitoringConfigSaved>, FormData>(
    saveMonitoringConfig,
    IDLE,
  );

  const changes = useMemo(() => diffConfig(config, draft), [config, draft]);

  function set<K extends keyof MonitoringConfig>(key: K, value: MonitoringConfig[K]): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
    // A change made after the review was opened invalidates it. Leaving the panel up would let
    // somebody confirm a diff that no longer describes the form.
    setReviewing(false);
  }

  function toggleDay(day: number): void {
    const present = draft.work_days.includes(day);
    const next = present ? draft.work_days.filter((value) => value !== day) : [...draft.work_days, day];
    set('work_days', next.sort((a, b) => a - b));
  }

  return (
    <div>
      <Section
        label="Sampling"
        title="How often the record is taken"
        aside={<span className="figure text-[0.8125rem] text-ink-faint">version {configVersion}</span>}
      >
        <div className="grid gap-6 border border-rule-strong bg-slip p-5 sm:grid-cols-2">
          <Field
            label="Sampling interval"
            htmlFor="sample_interval_seconds"
            hint="How often the agent notes which application is in front. A shorter interval means a more detailed record of the day. Between 15 and 900 seconds."
          >
            <input
              id="sample_interval_seconds"
              type="number"
              min={15}
              max={900}
              step={5}
              value={draft.sample_interval_seconds}
              onChange={(event) => set('sample_interval_seconds', Number(event.target.value))}
              className={figureInputClass}
            />
          </Field>

          <Field
            label="Idle after"
            htmlFor="idle_threshold_seconds"
            hint="How long without keyboard or mouse before time is recorded as idle. Idle minutes are still recorded and still shown — they are part of a day, not a failure."
          >
            <input
              id="idle_threshold_seconds"
              type="number"
              min={60}
              max={3600}
              step={30}
              value={draft.idle_threshold_seconds}
              onChange={(event) => set('idle_threshold_seconds', Number(event.target.value))}
              className={figureInputClass}
            />
          </Field>
        </div>
      </Section>

      <Section label="Collection" title="What is taken off the machine">
        <div className="space-y-5 border border-rule-strong bg-slip p-5">
          <Switch
            name="capture_window_titles"
            label="Window titles"
            checked={draft.capture_window_titles}
            onChange={(next) => set('capture_window_titles', next)}
            consequence="Records the title of the window in front. A title can name a document, a client or a diagnosis. With this off, only the application name is kept."
          />

          <Switch
            name="capture_urls"
            label="Web addresses"
            checked={draft.capture_urls}
            onChange={(next) => set('capture_urls', next)}
            consequence="Records the host of the page open in a browser — news.example.com, not the full address and never the query string."
          />

          <div className="border-t border-rule pt-5">
            <Switch
              name="screenshot_enabled"
              label="Screenshots"
              checked={draft.screenshot_enabled}
              onChange={(next) => set('screenshot_enabled', next)}
              consequence="Takes a periodic image of the whole screen. This is the most sensitive thing the software collects, and every time somebody opens one it is written to the access log."
            />

            {/* The dependent settings stay visible when screenshots are off, greyed rather than hidden:
                an owner deciding whether to turn capture on needs to see that blur exists before they
                decide, not after. */}
            <div className="mt-5 grid gap-6 border-l-2 border-rule pl-5 sm:grid-cols-2">
              <Field
                label="Screenshot interval"
                htmlFor="screenshot_interval_seconds"
                hint="Seconds between images. Between 60 and 7200."
              >
                <input
                  id="screenshot_interval_seconds"
                  type="number"
                  min={60}
                  max={7200}
                  step={30}
                  value={draft.screenshot_interval_seconds}
                  onChange={(event) => set('screenshot_interval_seconds', Number(event.target.value))}
                  disabled={!draft.screenshot_enabled}
                  className={figureInputClass}
                />
              </Field>

              <Switch
                name="screenshot_blur"
                label="Blur before upload"
                checked={draft.screenshot_blur}
                onChange={(next) => set('screenshot_blur', next)}
                disabled={!draft.screenshot_enabled}
                consequence="The image is blurred on the machine before it is sent, so text in it is not readable. Turning this off means readable images of whatever was on screen."
              />
            </div>
          </div>
        </div>
      </Section>

      <Section label="Hours" title="When recording happens">
        <div className="space-y-5 border border-rule-strong bg-slip p-5">
          <Switch
            name="work_hours_only"
            label="Work hours only"
            checked={draft.work_hours_only}
            onChange={(next) => set('work_hours_only', next)}
            consequence="Outside the window below, nothing is recorded at all — no time, no titles, no images. The agent stays running and collects nothing."
          />

          <div className="grid gap-6 sm:grid-cols-2">
            {/* `<input type="time">` speaks HH:MM; the column is a Postgres `time` and comes back as
                HH:MM:SS. Converted at the boundary so the value round-trips unchanged rather than
                appearing to change the moment it is saved. */}
            <Field label="Start" htmlFor="work_hours_start" hint="In each employee’s own timezone.">
              <input
                id="work_hours_start"
                type="time"
                value={draft.work_hours_start.slice(0, 5)}
                onChange={(event) => set('work_hours_start', `${event.target.value}:00`)}
                disabled={!draft.work_hours_only}
                className={figureInputClass}
              />
            </Field>
            <Field label="End" htmlFor="work_hours_end" hint="Must differ from the start.">
              <input
                id="work_hours_end"
                type="time"
                value={draft.work_hours_end.slice(0, 5)}
                onChange={(event) => set('work_hours_end', `${event.target.value}:00`)}
                disabled={!draft.work_hours_only}
                className={figureInputClass}
              />
            </Field>
          </div>

          <fieldset>
            <legend className="label">Working days</legend>
            <p className="mt-1 text-[0.8125rem] text-ink-soft">
              Days not listed here are not recorded when work hours are enforced.
            </p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <label key={day} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.work_days.includes(day)}
                    onChange={() => toggleDay(day)}
                    className="h-4 w-4 accent-active"
                  />
                  <span className="label">{WEEKDAY_NAMES[day]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Section>

      <Section label="Exclusions" title="What is never recorded">
        <div className="grid gap-6 border border-rule-strong bg-slip p-5 md:grid-cols-2">
          <Field
            label="Excluded applications"
            htmlFor="excluded_apps"
            hint="One per line. Nothing that happens in these applications is recorded — not the title, not the time. A password manager belongs here."
          >
            <textarea
              id="excluded_apps"
              rows={6}
              value={draft.excluded_apps.join('\n')}
              onChange={(event) => set('excluded_apps', toLines(event.target.value))}
              className={`${inputClass} font-mono text-[0.8125rem]`}
            />
          </Field>

          <Field
            label="Excluded addresses"
            htmlFor="excluded_url_patterns"
            hint="One per line. Pages matching these are not recorded at all. Banking, health and personal mail belong here."
          >
            <textarea
              id="excluded_url_patterns"
              rows={6}
              value={draft.excluded_url_patterns.join('\n')}
              onChange={(event) => set('excluded_url_patterns', toLines(event.target.value))}
              className={`${inputClass} font-mono text-[0.8125rem]`}
            />
          </Field>
        </div>
      </Section>

      <Section label="Retention" title="How long anything is kept">
        <div className="grid gap-6 border border-rule-strong bg-slip p-5 sm:grid-cols-2">
          <Field
            label="Keep activity for"
            htmlFor="retention_days_events"
            hint="Days. After this, activity records are deleted automatically and cannot be recovered."
          >
            <input
              id="retention_days_events"
              type="number"
              min={1}
              max={3650}
              value={draft.retention_days_events}
              onChange={(event) => set('retention_days_events', Number(event.target.value))}
              className={figureInputClass}
            />
          </Field>

          <Field
            label="Keep screenshots for"
            htmlFor="retention_days_screenshots"
            hint="Days, and never longer than activity is kept — an image without the activity that explains it serves no purpose."
          >
            <input
              id="retention_days_screenshots"
              type="number"
              min={1}
              max={3650}
              value={draft.retention_days_screenshots}
              onChange={(event) => set('retention_days_screenshots', Number(event.target.value))}
              className={figureInputClass}
            />
          </Field>
        </div>
      </Section>

      <div className="border-t border-rule-strong pt-5">
        {changes.length === 0 ? (
          <p className="text-[0.9rem] text-ink-soft">
            Nothing has changed. Adjust a setting above and a summary of the change will appear here before
            anything is saved.
          </p>
        ) : !reviewing ? (
          <div className="flex flex-wrap items-center gap-4">
            <button type="button" className={buttonClass} onClick={() => setReviewing(true)}>
              Review {changes.length} {changes.length === 1 ? 'change' : 'changes'}
            </button>
            <p className="text-[0.8125rem] text-ink-soft">Nothing is saved until you confirm.</p>
          </div>
        ) : (
          <form action={dispatch}>
            {/* The confirmed object, submitted verbatim. Re-reading the inputs after the confirmation
                would leave room for what was agreed to and what is sent to differ, and on this page
                that difference means somebody turned on screenshot capture without being told. */}
            <input type="hidden" name="config" value={JSON.stringify(draft)} />

            <h2 className="text-[1.15rem] leading-tight">Confirm these changes</h2>
            <p className="mt-1 text-[0.875rem] text-ink-soft">
              This replaces the whole configuration and becomes version {configVersion + 1}. Machines pick it
              up the next time they check in, within about fifteen minutes.
            </p>

            <ul className="mt-4 border border-rule-strong bg-slip">
              {changes.map((change, index) => (
                <li
                  key={change.key}
                  data-band={index % 2 === 1 ? 'true' : 'false'}
                  className={`border-b border-rule px-4 py-3 last:border-b-0 ${index % 2 === 1 ? 'bg-band' : ''}`}
                >
                  <p className="label">{change.label}</p>
                  <p className="figure mt-0.5 text-[0.9rem]">
                    <span className="text-ink-faint">{change.from}</span>
                    <span aria-hidden="true" className="mx-2 text-ink-faint">
                      →
                    </span>
                    <span className="text-ink">{change.to}</span>
                    <span className="sr-only"> changing to {change.to}</span>
                  </p>
                  {change.consequence !== undefined && (
                    <p className="mt-1 border-l-2 border-flag pl-2 text-[0.8125rem] leading-snug text-ink">
                      {change.consequence}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-4">
              <SubmitButton label="Save configuration" pendingLabel="Saving" />
              <button
                type="button"
                className={quietButtonClass}
                onClick={() => setReviewing(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="label underline decoration-rule underline-offset-4"
                onClick={() => {
                  setDraft(config);
                  setReviewing(false);
                }}
              >
                Discard changes
              </button>
            </div>
          </form>
        )}

        <div className="mt-4">
          <ActionNotice state={state} />
          {state.status === 'ok' && (
            <p className="mt-2 text-[0.875rem] text-ink-soft">
              Saved as version {state.value.config_version}.{' '}
              {state.value.changed_keys.length > 0 && (
                <>
                  The server recorded these fields as changed:{' '}
                  <span className="figure">{state.value.changed_keys.join(', ')}</span>.
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
