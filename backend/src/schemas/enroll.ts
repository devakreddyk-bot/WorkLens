/**
 * `POST /v1/device/enroll`.
 *
 * The only unauthenticated route on the device API — there is no device secret yet, because
 * producing one is what this call does. The enrolment token is therefore the whole of the
 * authentication, which is why its shape is checked tightly here rather than left to a
 * database lookup: a token that cannot possibly be one of ours should not reach the database
 * at all.
 */

import { z } from 'zod';

import { bounded, osSchema, trimmedBounded } from './common.js';

/**
 * `wlen_` + base64url of 32 random bytes, which is 43 unpadded characters.
 *
 * The prefix is not decoration. It makes a leaked token recognisable to a secret scanner
 * (gitleaks runs over this repository's full history in CI) and it makes an operator's
 * mistake — pasting a device id, or a KMS ARN — fail here with a clear message rather than as
 * a hash that matches nothing.
 *
 * The length is exact rather than a range. A token of any other length was not minted by this
 * system, so accepting it would only mean hashing it to discover the same thing.
 */
export const ENROLLMENT_TOKEN_PATTERN = /^wlen_[A-Za-z0-9_-]{43}$/;

export const enrollRequestSchema = z
  .object({
    /**
     * Hashed immediately and never stored, logged, or echoed. The field is named `token`
     * partly so the logger's redaction — which matches on key name — catches it if it ever
     * ends up inside something being logged.
     */
    token: z
      .string()
      .regex(
        ENROLLMENT_TOKEN_PATTERN,
        'must be an enrollment token of the form wlen_ followed by 43 base64url characters',
      ),

    // `devices.hostname` is `length(btrim(hostname)) between 1 and 255`.
    hostname: trimmedBounded(255),
    os: osSchema,

    // These three are `not null default ''` in the schema, so an agent that does not know
    // its own OS build or has no fingerprint yet is allowed to say nothing.
    os_version: bounded(100, 0).default(''),
    agent_version: bounded(40, 0).default(''),
    /**
     * A machine hash the agent derives locally. Used to notice that the *same* laptop has
     * re-enrolled, never to identify a person — which is why a cap and a character class are
     * all that is checked: the value is opaque to the backend by design.
     */
    machine_fingerprint: bounded(128, 0).default(''),
  })
  .strict();

export type EnrollRequest = z.output<typeof enrollRequestSchema>;
