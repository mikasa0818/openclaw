import { afterEach, describe, expect, it, vi } from "vitest";
import type { createXApiClient } from "./api.js";
import { createXTestApi, type XFetch } from "./test-support/api-client.js";

type Media = Parameters<ReturnType<typeof createXApiClient>["uploadMedia"]>[0];

const image: Media = {
  buffer: Buffer.from("synthetic-image-bytes"),
  contentType: "image/png",
  fileName: "image.png",
  mediaCategory: "tweet_image" as const,
};

describe("X media processing wait clock domain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fails the processing wait at its monotonic deadline when the wall clock rewinds", async () => {
    // The upload handshake (token refresh + initialize/append/finalize) runs on
    // real timers so the guarded dispatch stack behaves normally; once
    // finalize starts processing, only the wall-clock reading is rewound and
    // fake timers drive the monotonic processing deadline, like an NTP
    // correction landing mid-wait on a monotonic budget.
    const startedAt = Date.now();
    let finalizeStarted!: () => void;
    const finalizeStartedPromise = new Promise<void>((resolve) => {
      finalizeStarted = resolve;
    });
    let statusPolls = 0;
    const fetch: XFetch = (url, init) => {
      if (url.endsWith("/oauth2/token")) {
        return Promise.resolve(
          Response.json({
            access_token: "test-access",
            token_type: "bearer",
            expires_in: 999_999_999,
          }),
        );
      }
      void init;
      if (url.includes("/finalize")) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        // The monotonic processing deadline advances with the fake timer clock;
        // the wall-clock reading stays frozen at the rewound instant.
        vi.spyOn(Date, "now").mockReturnValue(startedAt - 10 * 60_000);
        finalizeStarted();
        return Promise.resolve(
          Response.json({
            data: { id: "101", processing_info: { state: "pending", check_after_secs: 1 } },
          }),
        );
      }
      if (url.includes("command=STATUS")) {
        statusPolls += 1;
        return Promise.resolve(
          Response.json({
            data: { id: "101", processing_info: { state: "pending", check_after_secs: 1 } },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: { id: "101" } }));
    };
    const api = createXTestApi({ clientSecret: "s", refreshToken: "r", fetch });
    // Settlement observer is attached before fake time advances; the recorded
    // outcome is asserted without leaving real timers behind.
    let settled: string | undefined;
    const upload = api.uploadMedia(image).then(
      () => {
        settled = "completed";
      },
      (error: unknown) => {
        settled = `error:${String((error as Error).message).slice(0, 60)}`;
      },
    );
    await finalizeStartedPromise;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 5_000); // ;
    expect(settled ?? "still-polling").toContain("timed out");
    expect(statusPolls).toBeGreaterThan(0);
    await upload;
  });
});
