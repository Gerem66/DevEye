import type { ItemAccess, ItemExtraOverrides } from '@deveye/types';

/**
 * Qui reçoit ce qu'un appareil renvoie. La télémétrie va à qui lit Appareils ;
 * le résultat d'un ordre, à qui tient la permission que cet ordre exige, sur
 * cet appareil.
 */
export type DeviceAudience =
    | { kind: 'read' }
    | { kind: 'extra'; key: string }
    /** Le résultat d'un changement de service : administrateur, avec l'écriture sur l'appareil. */
    | { kind: 'service' };

export const READERS: DeviceAudience = { kind: 'read' };
export const SERVICE_MANAGERS: DeviceAudience = { kind: 'service' };
export const holders = (key: string): DeviceAudience => ({ kind: 'extra', key });

/** Les droits d'une socket sur les appareils d'un espace, tels que le dispatcheur les a résolus. */
export interface DeviceGrants {
    read: boolean;
    write: boolean;
    admin: boolean;
    /** Permissions propres tenues à l'échelle de la fonctionnalité. */
    extras: ReadonlySet<string>;
    /** Surcharges du rôle, appareil par appareil : le niveau, puis les permissions. */
    access: ReadonlyMap<string, ItemAccess>;
    itemExtras: ReadonlyMap<string, ItemExtraOverrides>;
}

/** Ce que le hub retient d'une socket dans un espace, pour filtrer tout ce qu'il diffuse. */
export interface HubGrants {
    devices: DeviceGrants;
    /** La lecture de CloudSync : l'avancement et l'état d'un partage. */
    cloudSync: boolean;
}

export const NO_DEVICE_GRANTS: DeviceGrants = {
    read: false,
    write: false,
    admin: false,
    extras: new Set(),
    access: new Map(),
    itemExtras: new Map()
};

export const NO_HUB_GRANTS: HubGrants = { devices: NO_DEVICE_GRANTS, cloudSync: false };

/**
 * La règle de `authorizeReachableDevice`, appliquée à la diffusion : un appareil
 * masqué pour le rôle ne rend rien, un appareil en lecture seule ne rend que sa
 * télémétrie, et la surcharge d'une permission remplace ce que le rôle accorde.
 */
export function mayReceiveDevice(grants: DeviceGrants, deviceId: string, audience: DeviceAudience): boolean {
    if (!grants.read) return false;
    const override = grants.access.get(deviceId);
    if (override === 'none') return false;
    if (audience.kind === 'read') return true;
    if (override === 'read') return false;
    if (audience.kind === 'service') return grants.admin && (override === 'write' || grants.write);
    return grants.itemExtras.get(deviceId)?.[audience.key] ?? grants.extras.has(audience.key);
}
