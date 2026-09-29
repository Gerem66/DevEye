import { AGENT_TUNNEL_PROBE } from '@deveye/types';
import type { DatabaseDevice } from '../contracts/domain';
import {
    FeatureError,
    type AgentsFacade,
    type SdkAccessDenial,
    type SdkDevice,
    type SdkFeatureContext
} from '@deveye/types/sdk/server';

import type { DeviceRelay } from './tunnel';

/** La permission d'Appareils qui ouvre le réseau d'une machine à une autre fonctionnalité. */
export const DEVICE_NETWORK_RIGHT = 'network';

export const DENIALS: Record<SdkAccessDenial, string> = {
    not_member: 'il n’est plus membre de cet espace',
    suspended: 'son compte est suspendu',
    level: 'son rôle ne le permet plus',
    not_granted: 'la permission lui a été retirée',
    hidden: 'cet appareil lui est fermé',
    read_only: 'cet appareil est en lecture seule pour lui',
    no_device: 'l’appareil n’est plus dans cet espace'
};

/** L'appareil choisi pour une base, si l'appelant peut y ouvrir le réseau. */
export async function authorizeDevice(ctx: SdkFeatureContext<unknown>, deviceId: string | null): Promise<SdkDevice> {
    if (!deviceId) throw new FeatureError('validation', 'Choisissez l’appareil par lequel joindre cette base.');
    return ctx.deveye.devices.authorize(deviceId, { extras: [DEVICE_NETWORK_RIGHT] });
}

/** Les appareils de l'espace, chacun avec ce qui empêche l'appelant de le choisir. */
export async function deviceOptions(ctx: SdkFeatureContext<unknown>): Promise<DatabaseDevice[]> {
    const devices = await ctx.deveye.devices.list();
    return Promise.all(
        devices.map(async (device): Promise<DatabaseDevice> => {
            const allowed = await ctx.deveye.devices.authorize(device.id, { extras: [DEVICE_NETWORK_RIGHT] }).then(
                () => true,
                () => false
            );
            const agent = device.report?.agent;
            const blocked = !allowed
                ? 'Vous n’avez pas le droit « Accès au réseau de l’appareil » sur cet appareil.'
                : !agent?.probes.includes(AGENT_TUNNEL_PROBE)
                  ? 'Son agent est à mettre à jour pour joindre une base.'
                  : !agent.policy.tunnel
                    ? 'La machine refuse les tunnels : allow_tunnel = false dans la configuration de son agent.'
                    : null;
            return { id: device.id, name: device.name, online: device.online, blocked };
        })
    );
}

/** Le relais d'un appareil, après ce qui se dit mieux avant d'essayer : hors ligne, agent trop ancien. */
export function relayOf(agents: AgentsFacade, device: SdkDevice, online: boolean): DeviceRelay {
    if (!online) throw new Error(`L’appareil « ${device.name} » est hors ligne.`);
    if (!device.report?.agent?.probes.includes(AGENT_TUNNEL_PROBE)) {
        throw new Error(`L’agent de « ${device.name} » est à mettre à jour pour joindre une base.`);
    }
    return (target) => agents.openTcp(device.id, target);
}
