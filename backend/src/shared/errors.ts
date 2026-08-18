/**
 * The single error vocabulary for the API.
 *
 * Two rules govern this file:
 *
 *  1. **Every error the client sees comes from this enum.** A handler that throws
 *     something else produces an opaque 500, which is the correct outcome — an
 *     unclassified failure is a bug, and leaking its message would leak internals.
 *
 *  2. **The message is safe to show a caller.** No SQL, no stack, no internal
 *     identifier, no hint about whether a record exists. Diagnostic detail goes to the
 *     log, keyed by the same `requestId` the client is given, so support can join the
 *     two without the client ever seeing the second half.
 */

/** Machine-readable code. Clients switch on this, never on the message text. */
export const ErrorCode = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_JSON: 'MALFORMED_JSON',
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  // 401 — the caller has not proved who it is
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  /** Distinguished from INVALID_SIGNATURE on purpose: a laptop with a wrong clock is a
   *  support call, not an attack, and `agentctl doctor` reports it as such. */
  TIMESTAMP_OUT_OF_WINDOW: 'TIMESTAMP_OUT_OF_WINDOW',
  REPLAYED_REQUEST: 'REPLAYED_REQUEST',
  INVALID_TOKEN: 'INVALID_TOKEN',

  // 403 — the caller is known but not permitted
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  FORBIDDEN: 'FORBIDDEN',
  MFA_REQUIRED: 'MFA_REQUIRED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',

  // 404 / 409
  NOT_FOUND: 'NOT_FOUND',
  ENROLLMENT_TOKEN_USED: 'ENROLLMENT_TOKEN_USED',
  ENROLLMENT_TOKEN_EXPIRED: 'ENROLLMENT_TOKEN_EXPIRED',
  CONFLICT: 'CONFLICT',

  // 429 / 5xx
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  MALFORMED_JSON: 400,
  BATCH_TOO_LARGE: 400,
  PAYLOAD_TOO_LARGE: 413,

  MISSING_CREDENTIALS: 401,
  INVALID_SIGNATURE: 401,
  TIMESTAMP_OUT_OF_WINDOW: 401,
  REPLAYED_REQUEST: 401,
  INVALID_TOKEN: 401,

  DEVICE_REVOKED: 403,
  FORBIDDEN: 403,
  MFA_REQUIRED: 403,
  FEATURE_DISABLED: 403,

  NOT_FOUND: 404,
  ENROLLMENT_TOKEN_USED: 409,
  ENROLLMENT_TOKEN_EXPIRED: 410,
  CONFLICT: 409,

  QUOTA_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Structured detail attached to a 400, so a client can fix the request. */
export interface ErrorDetail {
  field?: string;
  message: string;
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;
  /**
   * Context for the log only. Never serialised into a response — this is where the
   * device id, the SQL constraint name, or the reason a signature failed belongs.
   */
  readonly logContext: Record<string, unknown>;
  /** Seconds a 429 asks the caller to wait. Becomes the Retry-After header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: ErrorDetail[];
      logContext?: Record<string, unknown>;
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details;
    this.logContext = options.logContext ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        requestId,
      },
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

// ---------------------------------------------------------------------------
// Constructors for the cases that recur, so their wording stays consistent
// ---------------------------------------------------------------------------

export const errors = {
  validation(details: ErrorDetail[]): AppError {
    return new AppError(ErrorCode.VALIDATION_FAILED, 'The request body failed validation.', {
      details,
    });
  },

  /**
   * Deliberately identical wording and code for every authentication failure that could
   * be probed: a caller must not be able to tell "unknown device" from "wrong secret",
   * because the difference tells an attacker which device ids are real.
   */
  unauthenticated(reason: string, logContext: Record<string, unknown> = {}): AppError {
    return new AppError(ErrorCode.INVALID_SIGNATURE, 'Request authentication failed.', {
      logContext: { ...logContext, reason },
    });
  },

  timestampOutOfWindow(skewSeconds: number, windowSeconds: number): AppError {
    return new AppError(
      ErrorCode.TIMESTAMP_OUT_OF_WINDOW,
      `Request timestamp is outside the accepted window of ±${windowSeconds}s. ` +
        `Check the device clock.`,
      { logContext: { skewSeconds, windowSeconds } },
    );
  },

  replayed(nonce: string): AppError {
    return new AppError(ErrorCode.REPLAYED_REQUEST, 'This request has already been processed.', {
      // The nonce is the caller's own value, so logging it is not a disclosure.
      logContext: { nonce },
    });
  },

  deviceRevoked(deviceId: string): AppError {
    return new AppError(
      ErrorCode.DEVICE_REVOKED,
      'This device has been revoked. Contact your administrator to re-enrol it.',
      { logContext: { deviceId } },
    );
  },

  quotaExceeded(retryAfterSeconds: number, logContext: Record<string, unknown> = {}): AppError {
    return new AppError(
      ErrorCode.QUOTA_EXCEEDED,
      'Ingest quota exceeded for this device. Retry after the indicated interval.',
      { retryAfterSeconds, logContext },
    );
  },

  featureDisabled(feature: string): AppError {
    return new AppError(
      ErrorCode.FEATURE_DISABLED,
      `${feature} is disabled by this organisation's monitoring configuration.`,
      { logContext: { feature } },
    );
  },

  notFound(what: string): AppError {
    return new AppError(ErrorCode.NOT_FOUND, `${what} was not found.`);
  },

  forbidden(logContext: Record<string, unknown> = {}): AppError {
    return new AppError(ErrorCode.FORBIDDEN, 'You do not have access to this resource.', {
      logContext,
    });
  },

  mfaRequired(): AppError {
    return new AppError(
      ErrorCode.MFA_REQUIRED,
      'Multi-factor authentication must be enabled on your account before you can access ' +
        'administrative data. Enrol an authenticator app and sign in again.',
    );
  },

  internal(cause: unknown, logContext: Record<string, unknown> = {}): AppError {
    return new AppError(ErrorCode.INTERNAL_ERROR, 'An internal error occurred.', {
      cause,
      logContext,
    });
  },
};
