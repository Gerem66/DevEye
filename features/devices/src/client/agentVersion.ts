import { compareVersions } from '@deveye/types';
import { APP_VERSION } from 'deveye-sdk-client';

/**
 * Whether a self-update is worth offering for a device. The operator-facing signal
 * is the version gap: the agent runs an older build than this interface (e.g. v0.4.1
 * vs interface v0.4.2), `APP_VERSION` being the DevEye version the interface was
 * built from. `agentUpdateAvailable` additionally covers the case where the server
 * already advertises a newer signed binary. Showing the affordance is decoupled
 * from whether the update will succeed: the update only goes through if a signed
 * binary is actually served, otherwise the agent reports a clear error, surfaced
 * to the user.
 */
export function agentUpdatable(device: { agentVersion: string | null; agentUpdateAvailable: boolean }): boolean {
    const outdated = device.agentVersion !== null && compareVersions(device.agentVersion, APP_VERSION) < 0;
    return outdated || device.agentUpdateAvailable;
}
