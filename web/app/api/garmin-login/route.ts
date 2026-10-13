import { NextResponse } from "next/server";
import { workerLogin } from "@/lib/garmin-login-worker";
import { toResponse } from "@/lib/garmin-login-response";
import { cooldownRemaining, formatCooldown } from "@/lib/garmin-cooldown";
import { getDb } from "@/lib/db";
import { resolveDatabaseUrl } from "@/lib/database-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/garmin-login
 * Body: { email, password }
 *
 * Step 1 of the Garmin sign-in. Sends the credentials to the direct-login
 * Cloudflare Worker (which runs the SSO from a non-blocked edge IP), and on a
 * clean success persists the returned DI tokens into platform_credentials
 * ('garmin_tokens') via DBTokenStore so the sync engine can use them. The
 * password is forwarded to the Worker only to obtain a token and is never
 * stored or echoed back.
 *
 * When the account has two-factor enabled the Worker returns needs_mfa with a
 * session_id; the client then posts the code to /api/garmin-login-mfa.
 */

export async function POST(request: Request) {
  let body: { email?: unknown; password?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ status: "error", error: "Invalid JSON body." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json(
      { status: "error", error: "Email and password are required." },
      { status: 400 },
    );
  }

  // Refuse while Garmin's cooldown is running. The cooldown was being recorded
  // and never read, so a rate-limited user could press sign in again straight
  // away, and every attempt deepens Garmin's own timer (#609).
  try {
    const remaining = await cooldownRemaining(getDb());
    if (remaining > 0) {
      return NextResponse.json(
        {
          status: "rate_limited",
          error: `Garmin rate-limited this account's sign-ins. Try again in ${formatCooldown(remaining)}. Signing in again before then makes the wait longer.`,
          retry_after_seconds: remaining,
        },
        { status: 429 },
      );
    }
  } catch {
    // No database, or an unreadable row. A cooldown we cannot check must not
    // block a sign-in that might be the user's only way back in.
  }

  const result = await workerLogin(email, password);
  return toResponse(resolveDatabaseUrl() ?? undefined, result);
}
