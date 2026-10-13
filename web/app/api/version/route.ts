import { NextResponse } from "next/server";

/**
 * GET /api/version — which build this deployment is serving.
 *
 * Every support conversation in this project ends with "use Sync fork on your
 * fork and redeploy", and until now nothing could confirm that it worked. When
 * the behaviour then does not change, "the deploy never took" and "the fix is
 * wrong" look identical from the outside, which is the ambiguity #189 was filed
 * about and #616 filed again after it came up on the r/Hevy thread.
 *
 * Python resolved a version by reading `pyproject.toml` from the source tree
 * FIRST, because on a source deploy the build can cache the installed package
 * metadata and report a stale version while the code is current
 * (`__init__.py:7-33`). That footer lived in `server.py` and went with it in
 * #514, so nothing has reported a version since.
 *
 * This reports the commit rather than a version string, because that is what a
 * forked deployment actually has: the fork's own version number never changes
 * when upstream does, and the commit does.
 */

// Never prerendered. A commit baked at build time would report whichever build
// prerendered the page, which is exactly the quietly-wrong answer this exists
// to prevent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.HEVY2GARMIN_COMMIT_SHA ?? null;
  return NextResponse.json({
    commit,
    short: commit ? commit.slice(0, 7) : null,
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    env: process.env.VERCEL_ENV ?? "self-hosted",
    // Says where the answer came from rather than inventing one. Off Vercel
    // there is no commit to read, and a caller comparing this against upstream
    // has to tell "serving something old" apart from "cannot tell", because
    // only one of those is a problem.
    source: process.env.VERCEL_GIT_COMMIT_SHA
      ? "vercel"
      : process.env.HEVY2GARMIN_COMMIT_SHA
        ? "env"
        : "unknown",
  });
}
