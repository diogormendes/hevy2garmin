import { describe, it, expect, vi } from "vitest";
import { uploadFit, GarminUploadRejected } from "../src/garmin";
import type { GarminClient } from "garmin-auth";

/**
 * Two upload outcomes that mean opposite things, and used to be one.
 *
 * `processing` means we do not know whether Garmin has the activity. Nothing may
 * be re-uploaded and reconciliation has to go and look.
 *
 * `failed` means Garmin refused the import outright. There is nothing on the
 * other side to find, waiting will never help, and the workout needs a person.
 *
 * Collapsing them left a definitively rejected upload sitting in `processing`
 * for ever, with reconcile searching Garmin for an activity that was never
 * created. Ported from `garmin.py:145-148` and `sync.py:635-641`.
 *
 * The rejection is NOT an HTTP status. Garmin answers 200 and puts the refusal
 * in the body, so a code-based check would miss every one of them.
 */

function clientReturning(body: unknown, status = 200) {
  const client = { domain: "garmin.com", di_token: "t", connectapi: async () => [] } as unknown as GarminClient;
  const fetchMock = vi.fn(async () => ({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
  return { client, fetchMock };
}

async function withFetch<T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

describe("a refused import is distinguishable from an unknown one (#587)", () => {
  it("throws GarminUploadRejected when Garmin reports failures and accepted nothing", async () => {
    const { client, fetchMock } = clientReturning({
      detailedImportResult: {
        uploadId: 99,
        successes: [],
        failures: [{ internalId: null, messages: [{ content: "Duplicate activity" }] }],
      },
    });

    await withFetch(fetchMock, async () => {
      await expect(uploadFit(client, new Uint8Array([1]), "2026-03-15T18:02:00+00:00")).rejects.toBeInstanceOf(
        GarminUploadRejected,
      );
    });
  });

  it("does not throw when Garmin reports failures but still accepted the activity", async () => {
    // A partial failure that still produced an activity is not a rejection.
    // Python only raises when there is no activity id AND no successes.
    const { client, fetchMock } = clientReturning({
      detailedImportResult: {
        uploadId: 99,
        successes: [{ internalId: 4242 }],
        failures: [{ messages: [{ content: "some field was ignored" }] }],
      },
    });

    await withFetch(fetchMock, async () => {
      const out = await uploadFit(client, new Uint8Array([1]), "2026-03-15T18:02:00+00:00");
      expect(out.activityId).toBe(4242);
    });
  });

  it("reports the upload id so a later reconcile can ask Garmin about this exact import", async () => {
    const { client, fetchMock } = clientReturning({
      detailedImportResult: { uploadId: 777, successes: [{ internalId: 1 }], failures: [] },
    });

    await withFetch(fetchMock, async () => {
      const out = await uploadFit(client, new Uint8Array([1]), "2026-03-15T18:02:00+00:00");
      expect(out.uploadId).toBe(777);
    });
  });

  it("a transport error is NOT a rejection, because the FIT may have landed", async () => {
    // This is the distinction that matters. A network failure after the request
    // left the machine tells us nothing about what Garmin did with it, so it
    // must stay in the "go and look" branch and never be reported as refused.
    const client = { domain: "garmin.com", di_token: "t" } as unknown as GarminClient;
    const boom = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    await withFetch(boom, async () => {
      await expect(uploadFit(client, new Uint8Array([1]), "2026-03-15T18:02:00+00:00")).rejects.not.toBeInstanceOf(
        GarminUploadRejected,
      );
    });
  });
});
