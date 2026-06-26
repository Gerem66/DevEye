import { ws } from '@/api/ws';

/**
 * Push a signed agent self-update for one device. Shared by every surface that
 * offers it — the Appareils card ({@link import('./Clients/useDeviceActions')})
 * and the Monitoring hooks ({@link import('./Monitoring/useAgentUpdate')}) — so the
 * core behaviour stays identical; only the in-flight state and error rendering
 * differ per surface.
 *
 * Resolves once the order is sent; rejects (with the server's reason) if it's
 * refused so the caller can surface it. The agent then verifies, swaps its binary
 * and reconnects with the new version shortly — hence the deferred second refresh.
 */
export async function runAgentUpdate(deviceId: string, refresh: () => void | Promise<void>): Promise<void> {
    await ws.send('device.updateAgent', { deviceId });
    await refresh();
    setTimeout(() => void refresh(), 4000);
}
