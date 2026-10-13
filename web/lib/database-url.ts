/**
 * Where the Postgres connection string comes from.
 *
 * The web read `DATABASE_URL` and nothing else, in nine places across eight
 * files. Python reads four names with `POSTGRES_URL` first (`db.py:24-38`), and
 * this project's own error message tells users to attach a Neon database
 * through Vercel Storage "so DATABASE_URL / POSTGRES_URL is set"
 * (`db_sqlite.py:39-44`). A user who follows that and ends up with only
 * `POSTGRES_URL` had a working Python deployment and a web one where every
 * route answers 503, naming a variable nobody told them to set (#615).
 *
 * One resolver rather than nine reads, because fixing only `getDb` would give a
 * deployment that connects to the database and still cannot store a Garmin
 * token, which is harder to diagnose than failing outright.
 */

/**
 * In Python's order, which is deliberate rather than alphabetical.
 *
 * `POSTGRES_URL` is first because on Vercel it is the POOLED endpoint, and
 * pooled is what a serverless function wants. The comment at `db.py:25` says so.
 */
export const DATABASE_URL_VARS = [
  "POSTGRES_URL",
  "DATABASE_URL",
  "STORAGE_URL",
  "NEON_DATABASE_URL",
] as const;

/**
 * The first of those that holds something that looks like a Postgres URL.
 *
 * The "postgres" or "neon" check is Python's (`db.py:36`) and matters more
 * here than there: `postgres(url)` accepts any string and fails later with
 * something unhelpful, so a leftover value in one of these names would turn a
 * missing-config problem into a connection error that points nowhere.
 */
export function resolveDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const name of DATABASE_URL_VARS) {
    const url = env[name]?.trim();
    if (url && (url.includes("postgres") || url.includes("neon"))) return url;
  }
  return null;
}

/** The names, for an error message that tells the user what to actually set. */
export const DATABASE_URL_HINT = DATABASE_URL_VARS.join(", ");
