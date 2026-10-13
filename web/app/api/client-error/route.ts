import { forwardClientError } from "@/lib/visit-counter";

/**
 * Optional error reports. The root layout's inline script sends an uncaught error here, and this
 * forwards it to the configured collector with the token, which never reaches a browser. Without
 * COLLECTOR_URL and COLLECTOR_TOKEN nothing is sent. Always 204.
 */
export async function POST(req: Request): Promise<Response> {
  await forwardClientError(req);
  return new Response(null, { status: 204 });
}
