import postgres from "postgres";
import { ensureSchema } from "./schema";
import { resolveDatabaseUrl, DATABASE_URL_HINT } from "./database-url";

/**
 * Tagged-template SQL function matching the @neondatabase/serverless shape
 * the ecosystem web apps are written against: `sql` returns Promise<rows[]>.
 *
 * Exposes `.json(x)` as a passthrough helper to mark values that must be sent
 * as a JSONB payload. Do NOT JSON.stringify values before `sql.json(x)` — that
 * produces a double-encoded string in the column.
 *
 * Reads the Postgres URL through `resolveDatabaseUrl`, which accepts the same
 * four variable names Python does, in the same order (#615).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  json: <T>(value: T) => unknown;
};

let cached: SqlTag | null = null;

export function getDb(): SqlTag {
  if (cached) return cached;
  const url = resolveDatabaseUrl();
  if (!url) {
    // Names all four, because the one a user has set is often not the one the
    // old message demanded: Vercel Storage sets POSTGRES_URL (#615).
    throw new Error(`No Postgres connection string. Set one of: ${DATABASE_URL_HINT}`);
  }
  const client = postgres(url, { prepare: false });

  // Every query waits for the one-time schema bootstrap (#475), so the first
  // write on a fresh database cannot outrun the CREATE TABLE statements.
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    ensureSchema(client)
      .then(() => (client as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values))
      .then((rows) => Array.from(rows) as Row[])) as SqlTag;

  tag.json = <T,>(value: T) => (client as unknown as { json: (v: T) => unknown }).json(value);

  cached = tag;
  return cached;
}
