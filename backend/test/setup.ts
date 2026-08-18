/**
 * Test bootstrap.
 *
 * `src/shared/config.ts` validates the environment at module load, which is deliberate —
 * a missing variable then fails on deploy rather than on the first request that reaches
 * the line using it. The consequence is that any test importing anything under `src/`
 * needs a valid environment before the import is evaluated, so this file runs first via
 * `setupFiles` in vitest.config.ts.
 *
 * The values are deliberately obvious fakes. Nothing here reaches AWS or a database:
 * tests mock `src/shared/db.ts` and inject root key material with
 * `setRootKeysForTest`.
 */

process.env.ENVIRONMENT = 'test';
process.env.AWS_REGION = 'ap-south-1';
process.env.LOG_LEVEL = 'error';

process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'worklens_test';
process.env.DB_USER = 'worklens_app';
process.env.DB_IAM_AUTH = '0';
process.env.DB_PASSWORD = 'not-a-real-password';
process.env.DB_SSL_MODE = 'disable';
process.env.DB_POOL_MAX = '1';

process.env.DEVICE_ROOT_KEY_SECRET_ARN =
  'arn:aws:secretsmanager:ap-south-1:000000000000:secret:worklens-test-device-root-key';
process.env.HMAC_TIMESTAMP_SKEW_SECONDS = '300';
process.env.NONCE_RETENTION_SECONDS = '600';

process.env.SCREENSHOT_BUCKET = 'worklens-test-screenshots';
process.env.SCREENSHOT_PREFIX = 'screenshots/';
process.env.S3_KMS_KEY_ARN = 'arn:aws:kms:ap-south-1:000000000000:key/00000000-0000-0000-0000-000000000000';

// Credentials for the AWS SDK, so a client constructed during a test does not go looking
// for the instance metadata service and stall.
process.env.AWS_ACCESS_KEY_ID = 'testing';
process.env.AWS_SECRET_ACCESS_KEY = 'testing';
process.env.AWS_SESSION_TOKEN = 'testing';
