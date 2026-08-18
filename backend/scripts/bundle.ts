/**
 * Builds one deployment zip per Lambda listed in `functions.json`.
 *
 * Each function is bundled with esbuild into a single `index.js`, then zipped to
 * `artifacts/<name>.zip`. Terraform reads the same `functions.json`, so the inventory
 * cannot drift between what is built and what is deployed.
 *
 * Bundling choices worth knowing:
 *
 *  - **AWS SDK v3 is bundled, not externalised.** The Node 22 Lambda runtime does ship
 *    the v3 SDK, but the version it ships changes without notice. Bundling costs a few
 *    hundred KB of package size and buys a deployment that behaves identically today and
 *    in six months. Determinism wins.
 *  - **`pg` is bundled with `pg-native` marked external.** `pg` conditionally requires
 *    `pg-native`, which is not installed and needs a C toolchain; marking it external
 *    keeps esbuild from failing on a require it will never execute at runtime.
 *  - **The RDS CA bundle ships in every zip.** `src/shared/db.ts` runs with
 *    `DB_SSL_MODE=verify-full` and fails closed when it cannot find the trust store, which
 *    is the right behaviour — silently downgrading to an unverified connection is exactly
 *    what verify-full exists to prevent. The functions are in private subnets with no
 *    internet route, so the bundle cannot be fetched at runtime and has to travel with the
 *    code.
 *  - **Zips are built deterministically.** All entries get a fixed mtime, so an unchanged
 *    handler produces a byte-identical zip and Terraform sees no diff. Without this,
 *    every build would show as a change to every function.
 *
 * Usage:
 *   npm run build                 build every function
 *   npm run build -- ingest       build only functions whose name contains "ingest"
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import process from 'node:process';

import { build } from 'esbuild';

const deflate = promisify(deflateRaw);

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, '..');
const ARTIFACT_DIR = join(BACKEND_ROOT, 'artifacts');
const BUILD_DIR = join(BACKEND_ROOT, '.build');

/**
 * The AWS RDS public trust store, committed at backend/assets/. Copied beside every
 * handler so `src/shared/db.ts` can verify the database's certificate. See the note above.
 */
const CA_BUNDLE_NAME = 'rds-ca-global-bundle.pem';
const CA_BUNDLE_SOURCE = join(BACKEND_ROOT, 'assets', CA_BUNDLE_NAME);

/**
 * Fixed timestamp for every zip entry, so builds are reproducible.
 * 1980-01-01 00:00:00 is the earliest time the zip format can represent.
 */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

interface FunctionSpec {
  name: string;
  entry: string;
  handler: string;
  vpc: boolean;
  timeout: number;
  memory: number;
  description: string;
}

interface FunctionsManifest {
  functions: FunctionSpec[];
}

// ---------------------------------------------------------------------------
// Minimal deterministic zip writer
// ---------------------------------------------------------------------------
// A dependency-free writer is used rather than shelling out to `zip`, because the
// system `zip` is not guaranteed to exist in CI images and cannot be made deterministic
// without extra flags that differ between BSD and GNU builds.

interface ZipEntry {
  path: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffff_ffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

async function writeZip(entries: ZipEntry[], outPath: string): Promise<number> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  // Sorted so the archive order does not depend on filesystem enumeration order.
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const compressed = await deflate(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filenames
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0); // central directory signature
    central.writeUInt16LE(0x031e, 4); // version made by: UNIX, zip 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    // External attrs: 0644 for files, in the high 16 bits, plus the regular-file bit.
    central.writeUInt32LE((0o100_644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...localParts, centralDir, end]);
  await writeFile(outPath, archive);
  return archive.length;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function collectFiles(dir: string, base = dir): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full, base)));
    } else if (entry.isFile()) {
      out.push({
        // Zip paths always use forward slashes, regardless of host platform.
        path: relative(base, full).split(/[\\/]/).join('/'),
        data: await readFile(full),
      });
    }
  }
  return out;
}

async function bundleFunction(spec: FunctionSpec): Promise<{ bytes: number; sha256: string }> {
  const entryPath = join(BACKEND_ROOT, spec.entry);
  if (!existsSync(entryPath)) {
    throw new Error(
      `${spec.name}: entry file ${spec.entry} does not exist. Either the handler has not ` +
        `been written yet, or functions.json points at the wrong path.`,
    );
  }

  const outDir = join(BUILD_DIR, spec.name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [entryPath],
    outfile: join(outDir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Lambda's Node runtime resolves .mjs as ESM; emitting index.js as ESM requires the
    // banner below so CommonJS interop inside bundled dependencies keeps working.
    banner: {
      js: [
        "import { createRequire as __wlCreateRequire } from 'node:module';",
        "import { fileURLToPath as __wlFileURLToPath } from 'node:url';",
        "import { dirname as __wlDirname } from 'node:path';",
        'const require = __wlCreateRequire(import.meta.url);',
        'const __filename = __wlFileURLToPath(import.meta.url);',
        'const __dirname = __wlDirname(__filename);',
      ].join('\n'),
    },
    // pg lazily requires pg-native, which is not installed and needs a C toolchain.
    external: ['pg-native'],
    // db-migrate imports the migration files as strings. RDS sits in a private subnet
    // with no public access, so migrations can only be applied from inside the VPC —
    // which means the SQL has to travel inside the function's own bundle.
    loader: { '.sql': 'text' },
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    treeShaking: true,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  // Lambda needs package.json type=module beside an ESM index.js, or it loads it as CJS.
  await writeFile(
    join(outDir, 'package.json'),
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    'utf8',
  );

  // Every function in this project talks to Postgres, so every zip gets the trust store.
  // If that ever stops being true, gate this on the function needing a VPC.
  await copyFile(CA_BUNDLE_SOURCE, join(outDir, CA_BUNDLE_NAME));

  const entries = await collectFiles(outDir);
  const zipPath = join(ARTIFACT_DIR, `${spec.name}.zip`);
  const bytes = await writeZip(entries, zipPath);
  const sha256 = createHash('sha256').update(await readFile(zipPath)).digest('base64');
  return { bytes, sha256 };
}

async function main(): Promise<void> {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  const manifestPath = join(BACKEND_ROOT, 'functions.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as FunctionsManifest;

  const selected = manifest.functions.filter(
    (f) => filters.length === 0 || filters.some((needle) => f.name.includes(needle)),
  );

  if (selected.length === 0) {
    throw new Error(
      `No functions matched ${JSON.stringify(filters)}. Available: ` +
        manifest.functions.map((f) => f.name).join(', '),
    );
  }

  if (!existsSync(CA_BUNDLE_SOURCE)) {
    throw new Error(
      `${CA_BUNDLE_NAME} is missing from backend/assets/. Every deployment package needs ` +
        `it, because the functions verify the database certificate and have no internet ` +
        `route to fetch it at runtime. Restore it with:\n\n` +
        `  curl -fsSL -o backend/assets/${CA_BUNDLE_NAME} \\\n` +
        `    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem\n`,
    );
  }

  await mkdir(ARTIFACT_DIR, { recursive: true });

  console.log(`[bundle] building ${selected.length} function(s) into artifacts/`);
  const results: { name: string; bytes: number; sha256: string }[] = [];

  for (const spec of selected) {
    const started = Date.now();
    const { bytes, sha256 } = await bundleFunction(spec);
    results.push({ name: spec.name, bytes, sha256 });
    console.log(
      `  ${spec.name.padEnd(28)} ${(bytes / 1024).toFixed(0).padStart(6)} KB  ` +
        `${Date.now() - started} ms`,
    );
  }

  // Written so `terraform plan` can key source_code_hash off the build output rather
  // than re-hashing zips itself, and so CI can diff build outputs between runs.
  await writeFile(
    join(ARTIFACT_DIR, 'manifest.json'),
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        functions: Object.fromEntries(results.map((r) => [r.name, { bytes: r.bytes, sha256: r.sha256 }])),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await rm(BUILD_DIR, { recursive: true, force: true });

  const total = results.reduce((sum, r) => sum + r.bytes, 0);
  console.log(`[bundle] done — ${(total / 1024 / 1024).toFixed(2)} MB total`);

  // Lambda rejects a deployment package over 50 MB zipped when uploaded directly.
  for (const r of results) {
    if (r.bytes > 45 * 1024 * 1024) {
      console.warn(
        `[bundle] WARNING ${r.name} is ${(r.bytes / 1024 / 1024).toFixed(1)} MB, close to ` +
          `Lambda's 50 MB direct-upload limit. Externalise a dependency or move to S3 upload.`,
      );
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n[bundle] ${message}\n`);
  process.exitCode = 1;
});
