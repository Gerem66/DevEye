import { compareVersions } from '@deveye/types';

/**
 * The DevEye version this UI was built from (single source of truth: package.json).
 * Also the reference an agent's reported version is compared against to decide
 * whether to offer a self-update.
 */
export const APP_VERSION = __APP_VERSION__;

/**
 * Whether a self-update is worth offering for a device. The operator-facing signal
 * is the version gap: the agent runs an older build than this interface (e.g. v0.4.1
 * vs interface v0.4.2). `agentUpdateAvailable` additionally covers the case where the
 * server already advertises a newer signed binary. Showing the affordance is decoupled
 * from whether the update will succeed: the update only goes through if a signed binary
 * is actually served — otherwise the agent reports a clear error, surfaced to the user.
 */
export function agentUpdatable(device: { agentVersion: string | null; agentUpdateAvailable: boolean }): boolean {
    const outdated = device.agentVersion !== null && compareVersions(device.agentVersion, APP_VERSION) < 0;
    return outdated || device.agentUpdateAvailable;
}
