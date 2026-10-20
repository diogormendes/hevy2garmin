import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SSO_WORKER_URL } from "garmin-auth";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { WORKER_EXCHANGE_URL } from "./connect-garmin";

// The browser sign-in posted its ticket to a deleted worker, so every attempt
// failed. It must use the shared worker that garmin-auth itself points at.
describe("Garmin browser sign-in", () => {
  it("exchanges the ticket on the shared SSO worker", () => {
    expect(WORKER_EXCHANGE_URL).toBe(`${DEFAULT_SSO_WORKER_URL}/exchange`);
  });
});
