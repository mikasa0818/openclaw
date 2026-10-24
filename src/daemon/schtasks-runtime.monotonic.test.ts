import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForScheduledTaskRunningEvidence } from "./schtasks-runtime.js";

type NativeResult = Pick<SpawnSyncReturns<string>, "stdout" | "stderr" | "status" | "error">;
const native = vi.hoisted(() =>
  vi.fn<(command: string, args?: readonly string[], options?: SpawnSyncOptions) => NativeResult>(),
);
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync: native,
}));

// The takeover-evidence budget runs on the monotonic clock, so this regression
// advances an independent monotonic reading while the wall-clock reading stays
// frozen at a rewound instant — the two-clock separation the series uses. The
// native probe is synthetic here; the real Task Scheduler trace stays runtime
// evidence in the PR body rather than a real-time wait in this suite.
describe("scheduled task fallback evidence clock domain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ends the evidence wait at its monotonic deadline when the wall clock rewinds", async () => {
    const startedAt = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(startedAt - 10 * 60_000);
    let monotonicMs = 0;
    const perfNow = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    let probes = 0;
    native.mockImplementation((_command, _args, options) => {
      probes += 1;
      // Each synthetic native probe consumes its bounded timeout the way a
      // real schtasks round trip consumes elapsed time.
      monotonicMs += options?.timeout ?? 15_000;
      return { stdout: "", stderr: "", status: 1, error: undefined };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: boolean | undefined;
    const wait = waitForScheduledTaskRunningEvidence({
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClawMonotonicProofNeverRunning",
    } as never).then((value) => {
      outcome = value;
    });
    // Settlement observer is attached before fake time advances; the recorded
    // outcome is asserted without leaving real timers behind.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(outcome).toBe(false);
    await wait;
    expect(probes).toBeGreaterThanOrEqual(1);
    // The whole 15s budget was consumed on the monotonic clock while the wall
    // clock stayed rewound, proving the deadline no longer reads wall time.
    expect(monotonicMs).toBeGreaterThanOrEqual(15_000);
    expect(monotonicMs).toBeLessThan(16_000);
    perfNow.mockRestore();
    wallClock.mockRestore();
  });
});
