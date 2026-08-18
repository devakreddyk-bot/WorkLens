/**
 * Cognito pre-token-generation trigger — injects the claims the API authorises against.
 *
 * ## Why this function exists at all
 *
 * A Cognito token proves *who* signed in. It says nothing about which organisation they
 * belong to, what role they hold, or which employee's data they are entitled to see — that
 * lives in the `users` table. Without this trigger every request would have to look those up
 * itself, which means an extra query on the hot path of every dashboard call and, worse, a
 * second place where the answer could be computed differently.
 *
 * Instead the claims are resolved once, at sign-in, and the API reads them from a token
 * Cognito has already verified.
 *
 * ## Why it enforces admin MFA (deviation D7)
 *
 * Cognito's MFA setting is pool-wide: `OFF`, `OPTIONAL` or `REQUIRED`. "MFA required for
 * admin accounts" cannot be expressed that way without also forcing TOTP on every employee
 * who only wants to see their own timesheet — a real cost for people who are not the risk
 * being managed.
 *
 * So the pool is `OPTIONAL`, this trigger asks Cognito whether the user actually has a
 * factor configured, and emits `wl:mfa`. The API rejects admin-scoped routes when an
 * `owner` or `manager` presents a token without it. Enforcement is server-side, on a claim
 * the client cannot forge, because it is inside a signature Cognito produced.
 *
 * ## Why it is inside the VPC
 *
 * Its claims come from Postgres, which is only reachable from the private subnets. It also
 * calls `AdminGetUser`, and with no NAT gateway (D6) that reaches Cognito through the
 * `cognito-idp` interface endpoint — which is why `infra/modules/network` defaults
 * `enable_cognito_vpc_endpoint` to true.
 *
 * ## Failing closed
 *
 * This trigger sits on the critical path of every login. A thrown error means nobody can
 * sign in, so the temptation is to swallow failures and let the login through. That would be
 * the wrong trade: a token without `wl:org` is a token the API cannot authorise, and a token
 * with a stale or absent `wl:mfa` is one that could let an admin past the MFA gate. It
 * therefore fails closed on anything it cannot establish, and logs the reason.
 *
 * The one deliberate exception is a user with no `users` row — see `handler`.
 */

import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type {
  PreTokenGenerationTriggerEvent,
  PreTokenGenerationV2TriggerEvent,
} from 'aws-lambda';

import { config } from '../../shared/config.js';
import { queryOne } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

/** Both trigger payload versions carry the fields this function needs. */
type TriggerEvent = PreTokenGenerationTriggerEvent | PreTokenGenerationV2TriggerEvent;

interface UserRow {
  id: string;
  org_id: string;
  role: 'owner' | 'manager' | 'employee';
  employee_id: string | null;
  status: 'active' | 'disabled';
  org_timezone: string;
}

let cognito: CognitoIdentityProviderClient | undefined;

/**
 * Looks the caller up by Cognito `sub`, not by email.
 *
 * `sub` is immutable; an email address is not. Matching on email would mean that changing
 * someone's address in Cognito silently detaches them from their row — or, if two rows ever
 * shared an address, attaches them to the wrong one.
 */
async function loadUser(cognitoSub: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>({
    name: 'pre-token-load-user',
    text: `select u.id,
                  u.org_id,
                  u.role,
                  u.employee_id,
                  u.status,
                  o.timezone as org_timezone
             from users u
             join organizations o on o.id = u.org_id
            where u.cognito_sub = $1`,
    values: [cognitoSub],
  });
}

/** Best-effort; a failure here must not block the login, so it is not awaited by the caller. */
async function touchLastLogin(userId: string): Promise<void> {
  await queryOne({
    name: 'pre-token-touch-login',
    text: 'update users set last_login_at = now() where id = $1 returning id',
    values: [userId],
  });
}

/**
 * Asks Cognito whether this user has a second factor configured.
 *
 * `UserMFASettingList` is the authoritative answer — it lists the factors actually enabled
 * for the user, as opposed to `MFAOptions`, which is a legacy field, or the pool's own
 * setting, which describes policy rather than this account.
 *
 * Note what this does and does not mean: it says a factor is *configured*, not that it was
 * *used* for this particular sign-in. With pool MFA at `OPTIONAL`, Cognito challenges a user
 * who has a factor configured, so in practice the two coincide. The distinction is recorded
 * here because it would matter if the pool policy ever changed.
 */
async function hasMfaConfigured(userPoolId: string, username: string): Promise<boolean> {
  cognito ??= new CognitoIdentityProviderClient({
    region: config.AWS_REGION,
    maxAttempts: 3,
  });

  const response = await cognito.send(
    new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
  );

  return (response.UserMFASettingList ?? []).length > 0;
}

const ADMIN_ROLES = new Set(['owner', 'manager']);

/**
 * Claims are namespaced `wl:` so they cannot collide with a reserved Cognito claim now or
 * after a future Cognito release adds one.
 */
function buildClaims(user: UserRow, mfa: boolean): Record<string, string> {
  return {
    'wl:org': user.org_id,
    'wl:user': user.id,
    'wl:role': user.role,
    // Empty string rather than omitted: `claimsToAddOrOverride` values must be strings, and
    // an absent key is indistinguishable from a key the trigger failed to set.
    'wl:employee': user.employee_id ?? '',
    'wl:tz': user.org_timezone,
    'wl:mfa': mfa ? 'on' : 'off',
  };
}

/**
 * Writes claims into whichever response shape this trigger version uses.
 *
 * V1 has a single `claimsOverrideDetails`; V2_0 splits it into `claimsAndScopeOverrideDetails`
 * with separate ID- and access-token sections. Both are handled because the pool's trigger
 * version is Terraform configuration, and a handler that silently no-ops when that changes
 * would produce tokens with no claims and a completely mysterious 403 on every request.
 */
function applyClaims(event: TriggerEvent, claims: Record<string, string>): TriggerEvent {
  if ('claimsAndScopeOverrideDetails' in event.response) {
    const v2 = event as PreTokenGenerationV2TriggerEvent;
    v2.response.claimsAndScopeOverrideDetails = {
      idTokenGeneration: { claimsToAddOrOverride: claims },
      accessTokenGeneration: { claimsToAddOrOverride: claims },
    };
    return v2;
  }

  const v1 = event as PreTokenGenerationTriggerEvent;
  v1.response.claimsOverrideDetails = { claimsToAddOrOverride: claims };
  return v1;
}

export async function handler(event: TriggerEvent): Promise<TriggerEvent> {
  const started = Date.now();
  const cognitoSub = event.request.userAttributes.sub ?? event.userName;

  const log = logger.child({
    handler: 'pre-token-generation',
    trigger: event.triggerSource,
    userPoolId: event.userPoolId,
  });

  try {
    const user = await loadUser(cognitoSub);

    if (user === undefined) {
      // The one case that does not fail closed. A Cognito account with no `users` row is
      // what an invited-but-not-yet-provisioned user looks like, and the alternative — a
      // hard failure — presents as "login is broken" rather than "your account is not set
      // up". The token is issued with no wl: claims, so the API's own authorisation rejects
      // every request it is used on, and the dashboard can show something meaningful.
      log.warn('no users row for this identity; issuing a token with no authorisation claims', {
        cognitoSub,
      });
      return event;
    }

    if (user.status !== 'active') {
      // Disabled accounts fail closed. Cognito may still hold a valid password, but the
      // authority on whether an account may be used is the users table.
      log.warn('sign-in refused: user is disabled', { userId: user.id, orgId: user.org_id });
      throw new Error('This account has been disabled.');
    }

    let mfa = false;
    if (ADMIN_ROLES.has(user.role)) {
      // Only queried for admins: for an employee the answer changes nothing, and this call
      // is on the critical path of every login.
      mfa = await hasMfaConfigured(event.userPoolId, event.userName);
      if (!mfa) {
        // Not refused here on purpose. The user needs a token to reach the enrolment screen
        // and set up a factor; `wl:mfa: off` is what stops that token opening admin data.
        log.warn('admin has no MFA factor configured; admin routes will reject this token', {
          userId: user.id,
          orgId: user.org_id,
          role: user.role,
        });
      }
    }

    const claims = buildClaims(user, mfa);

    // Best effort, and deliberately not awaited into the failure path: a failed bookkeeping
    // write must not stop someone signing in.
    void touchLastLogin(user.id).catch((err: unknown) => {
      log.warn('could not update last_login_at', { err, userId: user.id });
    });

    log.info('claims injected', {
      userId: user.id,
      orgId: user.org_id,
      role: user.role,
      mfa: claims['wl:mfa'],
      durationMs: Date.now() - started,
    });

    return applyClaims(event, claims);
  } catch (err) {
    // Rethrown, which Cognito surfaces as a failed sign-in. See the note on failing closed
    // at the top of this file: a token the API cannot authorise is worse than a login that
    // visibly failed.
    log.error('pre-token-generation failed', { err, durationMs: Date.now() - started });
    throw err;
  }
}
