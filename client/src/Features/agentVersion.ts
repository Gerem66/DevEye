/**
 * Shared agent-version helpers. The agent ships with each DevEye release, so its
 * version is expected to match the interface build — a mismatch means the agent
 * lags (or leads) the server and is worth a discreet "mise à jour disponible".
 */

/** DevEye version this UI was built from (single source of truth: package.json). */
export const APP_VERSION = __APP_VERSION__;

export interface AgentVersionInfo {
    /** Version string the agent reported (no leading "v"). */
    version: string;
    /** True when it differs from the interface build version. */
    mismatch: boolean;
}

/**
 * Normalize a device's reported agent version for display. Returns `null` when
 * nothing has been reported yet (the device has never connected), so callers can
 * simply skip rendering.
 */
export function agentVersionInfo(agentVersion: string | null): AgentVersionInfo | null {
    if (!agentVersion) return null;
    return { version: agentVersion, mismatch: agentVersion !== APP_VERSION };
}
