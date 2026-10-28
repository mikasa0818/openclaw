import { afterEach, describe, expect, it, vi } from "vitest";

const { callGatewayFromCliWithTransport, sleep } = vi.hoisted(() => ({
  callGatewayFromCliWithTransport: vi.fn(),
  sleep: vi.fn(async (ms: number) => {
    void ms;
  }),
}));

vi.mock("./gateway-rpc.js", () => ({ callGatewayFromCliWithTransport }));
vi.mock("../utils/sleep.js", () => ({ sleep }));

// The reload budget runs on the monotonic clock; the mocked sleeps advance a
// monotonic reading the way real elapsed time would, while the wall-clock
// reading stays frozen at a rewound instant — the two-clock separation the
// series uses. config.get keeps reporting an unapplied agent roster.
describe("claw agent reload wait clock domain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends the reload wait at its monotonic deadline when the wall clock rewinds", async () => {
    const { waitUntilClawAgentAvailable } = await import("./claws-agent-wait.js");
    const startedAt = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(startedAt - 10 * 60_000);
    let configGets = 0;
    callGatewayFromCliWithTransport.mockImplementation(async () => {
      configGets += 1;
      return {
        config: { agents: { entries: {} } },
        configRevisionHash: "saved",
        appliedConfigHash: "older",
      };
    });
    // Each sleep call advances the monotonic reading the way real elapsed time
    // would (the production poll interval is 100ms) and yields to the real
    // event loop so the bounded race can cap a rewound wall clock.
    let monotonicMs = 0;
    const perfNow = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    sleep.mockImplementation(async (ms: number) => {
      monotonicMs += ms;
      await new Promise((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, 0);
      });
    });
    // Settlement observer races the wait against a real-time cap the OLD
    // wall-clock window (rewound 10 minutes) can never reach.
    const outcome = await Promise.race([
      waitUntilClawAgentAvailable("agent-id").then(
        () => "settled",
        (error: unknown) => `error:${(error as Error).message.slice(0, 60)}`,
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still-running"), 5_000);
      }),
    ]);
    expect(outcome).toContain("did not apply");
    expect(configGets).toBeGreaterThan(0);
    perfNow.mockRestore();
    wallClock.mockRestore();
  });
});
