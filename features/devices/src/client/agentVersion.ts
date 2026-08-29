import { compareVersions } from '@deveye/types';
import { APP_VERSION } from 'deveye-sdk-client';

/**
 * Whether a self-update is worth offering: the agent runs an older build than
 * this interface (`APP_VERSION`), or the server advertises a newer signed
 * binary. Decoupled from whether the update will succeed: the agent reports a
 * clear error if no signed binary is served.
 */
export function agentUpdatable(device: { agentVersion: string | null; agentUpdateAvailable: boolean }): boolean {
    const outdated = device.agentVersion !== null && compareVersions(device.agentVersion, APP_VERSION) < 0;
    return outdated || device.agentUpdateAvailable;
}
