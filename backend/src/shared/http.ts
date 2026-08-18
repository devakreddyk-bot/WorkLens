/**
 * API Gateway request/response plumbing.
 *
 * `withHandler` wraps every Lambda entry point and owns four things no individual handler
 * should have to remember: a request id, structured entry/exit logging, mapping thrown
 * errors onto the response envelope in errors.ts, and making sure an unexpected throw
 * becomes an opaque 500 rather than a stack trace on the wire.
 */

import { randomUUID } from 'node:crypto';

import type { APIGatewayProxyEventV2, APIGatewayProxyResult } from 'aws-lambda';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

import { config } from './config.js';
import { AppError, ErrorCode, isAppError } from './errors.js';
import type { Logger} from './logger.js';
import { logger as rootLogger } from './logger.js';

/** REST API (v1) is what this deployment uses; the v2 shape is accepted for tests. */
export type ApiEvent = APIGatewayProxyEvent | APIGatewayProxyEventV2;

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  /** Raw body, exactly as received. The HMAC covers these bytes, so it must not be reparsed
   *  and re-serialised before verification. */
  rawBody: string;
  headers: Record<string, string | undefined>;
  pathParameters: Record<string, string | undefined>;
  queryParameters: Record<string, string | undefined>;
  sourceIp: string | undefined;
  userAgent: string | undefined;
  log: Logger;
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // The API serves JSON to a browser-based dashboard and to the agent. These cost nothing
  // and close off content sniffing and framing entirely.
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  // A JSON API needs no scripting, styling or framing capability at all.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

function methodOf(event: ApiEvent): string {
  if ('httpMethod' in event && typeof event.httpMethod === 'string') return event.httpMethod;
  if ('requestContext' in event && 'http' in event.requestContext) {
    return event.requestContext.http.method;
  }
  return 'GET';
}

/**
 * The path the signature is computed over.
 *
 * `event.path` on a REST API is the path *after* the stage, which is what the agent puts
 * in its request line, so the two agree. `resource` would not: it contains `{id}`
 * placeholders rather than actual values.
 */
function pathOf(event: ApiEvent): string {
  if ('path' in event && typeof event.path === 'string') return event.path;
  if ('requestContext' in event && 'http' in event.requestContext) {
    return event.requestContext.http.path;
  }
  return '/';
}

function bodyOf(event: ApiEvent): string {
  const raw = event.body ?? '';
  if (raw === '') return '';
  // API Gateway base64-encodes a body it considers binary. Decoding here means the HMAC is
  // computed over the same bytes the agent signed either way.
  return event.isBase64Encoded === true ? Buffer.from(raw, 'base64').toString('utf8') : raw;
}

function normaliseHeaders(event: ApiEvent): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
}

function sourceIpOf(event: ApiEvent): string | undefined {
  const ctx = event.requestContext as unknown as Record<string, unknown> | undefined;
  if (ctx === undefined) return undefined;
  const identity = ctx.identity as { sourceIp?: string } | undefined;
  if (identity?.sourceIp !== undefined) return identity.sourceIp;
  const http = ctx.http as { sourceIp?: string } | undefined;
  return http?.sourceIp;
}

export interface JsonResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): JsonResponse {
  return { status, body, headers };
}

export const ok = (body: unknown): JsonResponse => json(200, body);
export const created = (body: unknown): JsonResponse => json(201, body);
export const noContent = (): JsonResponse => json(204, null);

function toProxyResult(response: JsonResponse): APIGatewayProxyResult {
  return {
    statusCode: response.status,
    headers: { ...SECURITY_HEADERS, ...(response.headers ?? {}) },
    body: response.body === null ? '' : JSON.stringify(response.body),
  };
}

export type Handler = (ctx: RequestContext, event: ApiEvent) => Promise<JsonResponse>;

/**
 * Wraps a handler with request context, logging and error mapping.
 *
 * The request id comes from API Gateway when present so a client-reported id can be found
 * in both the access log and the application log; a generated fallback keeps local tests
 * and direct invocations working.
 */
export function withHandler(name: string, handler: Handler) {
  return async (event: ApiEvent, lambdaContext?: Context): Promise<APIGatewayProxyResult> => {
    const gatewayRequestId =
      (event.requestContext as { requestId?: string } | undefined)?.requestId ??
      lambdaContext?.awsRequestId;
    const requestId = gatewayRequestId ?? randomUUID();

    const method = methodOf(event);
    const path = pathOf(event);
    const headers = normaliseHeaders(event);

    const log = rootLogger.child({ requestId, handler: name, method, path });

    const ctx: RequestContext = {
      requestId,
      method,
      path,
      rawBody: bodyOf(event),
      headers,
      pathParameters: (event.pathParameters ?? {}),
      queryParameters: (event.queryStringParameters ?? {}),
      sourceIp: sourceIpOf(event),
      userAgent: headers['user-agent'],
      log,
    };

    const started = Date.now();
    log.info('request received', {
      bytes: ctx.rawBody.length,
      ...(config.LOG_REQUEST_BODIES && ctx.rawBody !== '' ? { body: ctx.rawBody } : {}),
    });

    try {
      const response = await handler(ctx, event);
      log.info('request completed', { status: response.status, durationMs: Date.now() - started });
      return toProxyResult(response);
    } catch (err) {
      const appError = isAppError(err)
        ? err
        : new AppError(ErrorCode.INTERNAL_ERROR, 'An internal error occurred.', { cause: err });

      // 4xx is the caller's problem and is logged at warn; 5xx is ours and gets error plus
      // the full cause chain, because that is what someone will be reading at 2 a.m.
      const level = appError.status >= 500 ? 'error' : 'warn';
      log[level]('request failed', {
        status: appError.status,
        code: appError.code,
        durationMs: Date.now() - started,
        ...appError.logContext,
        ...(appError.status >= 500 ? { err } : {}),
      });

      return toProxyResult(
        json(
          appError.status,
          appError.toBody(requestId),
          appError.retryAfterSeconds === undefined
            ? {}
            : { 'retry-after': String(appError.retryAfterSeconds) },
        ),
      );
    }
  };
}

/**
 * Parses a JSON body, rejecting anything that is not an object.
 *
 * A bare array or scalar at the top level is rejected before Zod sees it, so schemas do
 * not each have to restate that they expect an object.
 */
export function parseJsonBody(ctx: RequestContext): unknown {
  if (ctx.rawBody === '') return {};

  if (ctx.rawBody.length > config.INGEST_MAX_BODY_BYTES) {
    throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large.', {
      logContext: { bytes: ctx.rawBody.length, limit: config.INGEST_MAX_BODY_BYTES },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody);
  } catch {
    throw new AppError(ErrorCode.MALFORMED_JSON, 'Request body is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError(ErrorCode.MALFORMED_JSON, 'Request body must be a JSON object.');
  }

  return parsed;
}
