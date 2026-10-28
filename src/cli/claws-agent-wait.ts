import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sleep } from "../utils/sleep.js";
import { callGatewayFromCliWithTransport } from "./gateway-rpc.js";

export const CLAW_AGENT_RELOAD_TIMEOUT_MS = 15_000;
export const CLAW_AGENT_RELOAD_POLL_MS = 100;

/**
 * Waits for the Gateway to apply the Claw agent's entry with matching config
 * revision hashes. The reload budget is consumed by sleep polls on the
 * monotonic clock; the deadline must live there too, or a wall-clock step
 * (NTP correction, VM resume) keeps polling past the configured window.
 */
export async function waitUntilClawAgentAvailable(agentId: string): Promise<void> {
  const deadline = performance.now() + CLAW_AGENT_RELOAD_TIMEOUT_MS;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const response = await callGatewayFromCliWithTransport<{
        config?: OpenClawConfig;
        configRevisionHash?: unknown;
        appliedConfigHash?: unknown;
      }>("config.get", { timeout: "5000" }, {});
      // Matching tokens can describe a cached roster from before this agent was added.
      if (
        Object.hasOwn(response.config?.agents?.entries ?? {}, agentId) &&
        typeof response.configRevisionHash === "string" &&
        response.configRevisionHash === response.appliedConfigHash
      ) {
        return;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(CLAW_AGENT_RELOAD_POLL_MS);
  }
  const suffix = lastError instanceof Error ? ": " + lastError.message : "";
  throw new Error("Gateway did not apply the Claw agent configuration in time" + suffix);
}
