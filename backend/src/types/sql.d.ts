/**
 * `.sql` files are imported as strings.
 *
 * esbuild is configured with `loader: { '.sql': 'text' }` (backend/scripts/bundle.ts), which
 * turns an import of a `.sql` file into its contents. TypeScript has no idea about that on
 * its own, so this declares the shape.
 *
 * Used only by src/handlers/jobs/dbMigrate.ts, which carries the migrations inside its own
 * bundle because the deployed database is unreachable from anywhere else.
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
