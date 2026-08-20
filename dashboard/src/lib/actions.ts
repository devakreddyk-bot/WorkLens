'use server';

/**
 * Server Actions — every write the dashboard makes, plus the two reads that must not happen on load.
 *
 * # Why the writes are here and not in the pages
 *
 * `lib/api.ts` imports `next/headers`, so it can only run on the server. An action is how a form in
 * the browser reaches it without the access token ever being handed to client JavaScript. The
 * alternative — a route handler per form — would be the same code with a URL attached to it.
 *
 * # Why two *reads* are here
 *
 * `screenshotUrl` and `exportCsv` are reads, and they are actions because they must happen on a click
 * rather than on render. A presigned screenshot URL lives 300 seconds and every issue is written to
 * the audit log before the URL exists, so fetching a gallery's worth on load would produce images that
 * break five minutes later *and* a record saying somebody viewed images they never opened. The export
 * is audited on the same reasoning: it is a bulk read of every monitored person's hours, and it should
 * appear in the trail when an owner asked for it, not when they opened the page.
 *
 * # Every action returns, none of them throw
 *
 * A thrown error in an action reaches the error boundary and takes the whole page with it, which
 * loses whatever the person had typed. These return an `ActionError` instead, so the failure appears
 * beside the form. The exception is a framework control-flow signal — `redirect()` from an expired
 * token — which has to keep propagating or the redirect never happens.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import type {
  CsvExportEnvelope,
  DeletionScope,
  EnrollmentTokenIssued,
  MonitoringConfig,
  MonitoringConfigSaved,
  ProjectMatchType,
  ScreenshotUrlResponse,
} from './api';
import {
  createDeletionRequest,
  createEnrollmentToken,
  createProject,
  createProjectRule,
  createUser,
  deactivateProject,
  deleteProjectRule,
  executeDeletionRequest,
  fetchScreenshotUrl,
  fetchTimesheetExport,
  patchProject,
  patchUser,
  putMonitoringConfig,
  revokeDevice,
} from './api';
import type { ActionResult, FormState } from './action-result';
import { attempt, integer, optionalText, text } from './action-support';

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/**
 * One screenshot's URL, fetched when somebody actually opens the image.
 *
 * Not batched, not prefetched, and deliberately not called from a `<Suspense>` boundary that might
 * run speculatively. See the module header.
 */
export async function screenshotUrl(
  employeeId: string,
  screenshotId: string,
): Promise<ActionResult<ScreenshotUrlResponse>> {
  return attempt('The image could not be opened. Try again.', () =>
    fetchScreenshotUrl(employeeId, screenshotId),
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The payroll CSV, as a base64 envelope the browser turns into a file.
 *
 * The envelope is not a design choice made here: `backend/src/shared/http.ts` serialises every
 * response body with `JSON.stringify`, so a raw `text/csv` body cannot travel through the shared
 * wrapper. A real `text/csv` response would need a raw-response branch in its `toProxyResult`; until
 * then the bytes come back base64-encoded and the download is assembled from a Blob client-side,
 * which keeps the BOM and the CRLF line endings byte-exact.
 */
export async function exportCsv(
  from: string,
  to: string,
  employeeId: string | null,
): Promise<ActionResult<CsvExportEnvelope>> {
  return attempt('The export did not run. Try a shorter date range.', () =>
    fetchTimesheetExport(from, to, employeeId ?? undefined),
  );
}

// ---------------------------------------------------------------------------
// Monitoring configuration
// ---------------------------------------------------------------------------

/**
 * The shape of the configuration payload, checked structurally and no further.
 *
 * Every bound — 15 to 900 seconds, retention up to 3650 days, screenshots not kept longer than the
 * activity that explains them — is a CHECK constraint in `0001_init.sql` and a Zod rule in
 * `backend/src/schemas/dashboard.ts`. Restating them here would be a second copy that eventually
 * disagrees, and the disagreement would surface as the dashboard refusing something the server would
 * have accepted. So this only confirms the object is the right *shape*; the API decides whether the
 * values are allowed and its message is what the form displays.
 */
const configPayload = z.object({
  sample_interval_seconds: z.number().int(),
  idle_threshold_seconds: z.number().int(),
  capture_window_titles: z.boolean(),
  capture_urls: z.boolean(),
  screenshot_enabled: z.boolean(),
  screenshot_interval_seconds: z.number().int(),
  screenshot_blur: z.boolean(),
  work_hours_only: z.boolean(),
  work_hours_start: z.string(),
  work_hours_end: z.string(),
  work_days: z.array(z.number().int()),
  excluded_apps: z.array(z.string()),
  excluded_url_patterns: z.array(z.string()),
  retention_days_events: z.number().int(),
  retention_days_screenshots: z.number().int(),
});

/**
 * Saves the monitoring configuration.
 *
 * The whole object arrives as one JSON field rather than sixteen form inputs, so that what the
 * diff-confirm dialog showed and what the API receives are the same value. Re-reading sixteen inputs
 * after the confirmation would leave room for the two to differ, and on this page the two differing
 * means an owner turned on screenshot capture without being told they had.
 */
export async function saveMonitoringConfig(
  _previous: FormState<MonitoringConfigSaved>,
  form: FormData,
): Promise<FormState<MonitoringConfigSaved>> {
  let parsed: MonitoringConfig;
  try {
    parsed = configPayload.parse(JSON.parse(text(form, 'config')));
  } catch {
    return {
      status: 'error',
      message: 'The settings did not reach the server intact. Reload the page and try again.',
      fields: {},
      requestId: null,
    };
  }

  const result = await attempt('The settings were not saved.', () => putMonitoringConfig(parsed));
  if (result.status === 'ok') revalidatePath('/settings/monitoring');
  return result;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function addProject(
  _previous: FormState<string>,
  form: FormData,
): Promise<FormState<string>> {
  const name = text(form, 'name');
  const code = optionalText(form, 'code');

  const result = await attempt('The project was not created.', async () => {
    const created = await createProject({ name, code, is_active: true });
    return `Added ${created.project.name}.`;
  });

  if (result.status === 'ok') revalidatePath('/projects');
  return result;
}

/**
 * Retires a project rather than deleting it.
 *
 * The route is `DELETE` and the effect is `is_active = false`, because `timesheet_project_totals`
 * cascades from `projects`: a real delete would rewrite every past breakdown that named the project,
 * and a payroll export run last month would stop reproducing. The button says "Retire" so nobody
 * expects otherwise.
 */
export async function retireProject(
  projectId: string,
  _previous: FormState<string>,
  _form: FormData,
): Promise<FormState<string>> {
  const result = await attempt('The project was not retired.', async () => {
    const outcome = await deactivateProject(projectId);
    return `${outcome.project.name} is retired. Its past totals are unchanged.`;
  });

  if (result.status === 'ok') revalidatePath('/projects');
  return result;
}

export async function restoreProject(
  projectId: string,
  _previous: FormState<string>,
  _form: FormData,
): Promise<FormState<string>> {
  const result = await attempt('The project was not restored.', async () => {
    const outcome = await patchProject(projectId, { is_active: true });
    return `${outcome.project.name} is active again.`;
  });

  if (result.status === 'ok') revalidatePath('/projects');
  return result;
}

export async function addProjectRule(
  projectId: string,
  _previous: FormState<string>,
  form: FormData,
): Promise<FormState<string>> {
  const matchType = text(form, 'match_type') as ProjectMatchType;
  const pattern = text(form, 'pattern');
  const priority = integer(form, 'priority', 100);

  const result = await attempt('The rule was not added.', async () => {
    await createProjectRule(projectId, { match_type: matchType, pattern, priority });
    return 'Rule added. It applies to activity recorded from now on.';
  });

  if (result.status === 'ok') revalidatePath('/projects');
  return result;
}

/**
 * Deletes a matching rule.
 *
 * A real delete, unlike a project: a rule owns no historical totals. Time already attributed by it
 * stays attributed, which the interface says out loud — otherwise removing a rule looks like it
 * should reassign the past.
 */
export async function removeProjectRule(
  projectId: string,
  ruleId: string,
  _previous: FormState<string>,
  _form: FormData,
): Promise<FormState<string>> {
  const result = await attempt('The rule was not deleted.', async () => {
    await deleteProjectRule(projectId, ruleId);
    return 'Rule deleted. Time already attributed by it stays attributed.';
  });

  if (result.status === 'ok') revalidatePath('/projects');
  return result;
}

// ---------------------------------------------------------------------------
// Dashboard users
// ---------------------------------------------------------------------------

/**
 * Registers a dashboard user.
 *
 * This creates the `users` row and nothing else. The account itself lives in the Cognito user pool
 * and cannot be created from here — `admin-api` holds no `cognito-idp` permission — which is why the
 * form asks for a subject id that already exists rather than sending an invitation.
 */
export async function addUser(
  _previous: FormState<string>,
  form: FormData,
): Promise<FormState<string>> {
  const role = text(form, 'role');
  const employeeId = optionalText(form, 'employee_id');

  if (role !== 'owner' && role !== 'manager' && role !== 'employee') {
    return { status: 'error', message: 'Choose a role.', fields: { role: 'is required' }, requestId: null };
  }

  const result = await attempt('The user was not added.', async () => {
    const created = await createUser({
      cognito_sub: text(form, 'cognito_sub'),
      email: text(form, 'email'),
      role,
      employee_id: employeeId,
      status: 'active',
    });
    return `${created.user.email} can now sign in as ${created.user.role}.`;
  });

  if (result.status === 'ok') revalidatePath('/settings/users');
  return result;
}

export async function changeUserRole(
  userId: string,
  _previous: FormState<string>,
  form: FormData,
): Promise<FormState<string>> {
  const role = text(form, 'role');
  if (role !== 'owner' && role !== 'manager' && role !== 'employee') {
    return { status: 'error', message: 'Choose a role.', fields: { role: 'is required' }, requestId: null };
  }

  const result = await attempt('The role was not changed.', async () => {
    const updated = await patchUser(userId, { role });
    return `${updated.user.email} is now ${updated.user.role}. It takes effect at their next sign-in.`;
  });

  if (result.status === 'ok') revalidatePath('/settings/users');
  return result;
}

export async function setUserStatus(
  userId: string,
  status: 'active' | 'disabled',
  _previous: FormState<string>,
  _form: FormData,
): Promise<FormState<string>> {
  const result = await attempt('The account was not changed.', async () => {
    const updated = await patchUser(userId, { status });
    return status === 'disabled'
      ? `${updated.user.email} can no longer sign in to the dashboard.`
      : `${updated.user.email} can sign in again.`;
  });

  if (result.status === 'ok') revalidatePath('/settings/users');
  return result;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * Mints an enrolment token.
 *
 * The value in the result is the only time it exists anywhere outside the operator's terminal: the
 * API stores only its SHA-256. The form says so, because a flow built on the assumption that it can
 * be read back later silently cannot work.
 */
export async function issueEnrollmentToken(
  _previous: FormState<EnrollmentTokenIssued>,
  form: FormData,
): Promise<FormState<EnrollmentTokenIssued>> {
  const employeeId = text(form, 'employee_id');
  if (employeeId === '') {
    return {
      status: 'error',
      message: 'Choose who the device belongs to.',
      fields: { employee_id: 'is required' },
      requestId: null,
    };
  }

  const result = await attempt('The token was not issued.', () =>
    createEnrollmentToken({ employee_id: employeeId, expires_in_hours: integer(form, 'expires_in_hours', 24) }),
  );

  if (result.status === 'ok') revalidatePath('/settings/devices');
  return result;
}

export async function revokeDeviceAction(
  deviceId: string,
  _previous: FormState<string>,
  _form: FormData,
): Promise<FormState<string>> {
  const result = await attempt('The device was not revoked.', async () => {
    const outcome = await revokeDevice(deviceId);
    // The API uses `coalesce(revoked_at, now())`, so re-revoking keeps the original moment — the one
    // that matters if anyone has to reconstruct when a laptop stopped being trusted.
    return `Revoked at ${outcome.revoked_at}. The agent on that machine stops being accepted; the records it already sent are kept.`;
  });

  if (result.status === 'ok') revalidatePath('/settings/devices');
  return result;
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

export async function requestErasure(
  _previous: FormState<string>,
  form: FormData,
): Promise<FormState<string>> {
  const employeeId = text(form, 'employee_id');
  const scope = text(form, 'scope');

  if (employeeId === '') {
    return {
      status: 'error',
      message: 'Choose whose data this is about.',
      fields: { employee_id: 'is required' },
      requestId: null,
    };
  }
  if (scope !== 'all' && scope !== 'screenshots' && scope !== 'events') {
    return { status: 'error', message: 'Choose what to erase.', fields: { scope: 'is required' }, requestId: null };
  }

  const reason = optionalText(form, 'reason');
  const result = await attempt('The request was not recorded.', async () => {
    await createDeletionRequest({
      employee_id: employeeId,
      scope: scope satisfies DeletionScope,
      ...(reason === null ? {} : { reason }),
    });
    return 'Recorded. Nothing is deleted until you run it.';
  });

  if (result.status === 'ok') revalidatePath('/settings/data');
  return result;
}

/**
 * Runs an erasure. There is no undo, and the interface says so before the button is pressed.
 *
 * The audit rows describing the erasure and the accesses that preceded it are kept — deliberately,
 * and enforced by grant rather than by intention: `worklens_app` has no `delete` on `audit_log`. A
 * deletion you cannot evidence is worse than no deletion at all.
 */
export async function runErasure(
  requestId: string,
  _previous: FormState<string>,
  _form: FormData,
): Promise<FormState<string>> {
  const result = await attempt('The erasure did not complete. Nothing partial was left behind.', async () => {
    const outcome = await executeDeletionRequest(requestId);
    const request = outcome.deletion_request;
    const events = request.deleted_event_count ?? 0;
    const screenshots = request.deleted_screenshot_count ?? 0;
    return `Erased ${events} activity records and ${screenshots} screenshots.`;
  });

  if (result.status === 'ok') revalidatePath('/settings/data');
  return result;
}
