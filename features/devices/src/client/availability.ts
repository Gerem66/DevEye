import type { Device } from '@deveye/types';

import { manifest } from '../manifest';

/** Pourquoi une entrée du menu est inerte : le glyphe qui le dit, la phrase en infobulle. */
export interface Unavailable {
    icon: string;
    reason: string;
}

/**
 * La permission propre que le rôle n'accorde pas. L'intitulé vient du manifest,
 * qui est aussi celui que l'éditeur de rôles affiche : l'infobulle nomme donc
 * exactement la case à cocher.
 */
export function missingPermission(key: string): Unavailable {
    const label = manifest.extraPermissions.find((p) => p.key === key)?.label ?? key;
    return { icon: 'icon-lock', reason: `Permission « ${label} » requise sur Appareils` };
}

export const NO_WRITE: Unavailable = {
    icon: 'icon-lock',
    reason: 'Droit d’écriture requis sur Appareils'
};

export const FOREIGN: Unavailable = {
    icon: 'icon-users',
    reason: 'Appareil partagé : il se gère dans l’espace où il a été appairé'
};

export const ARCHIVED: Unavailable = {
    icon: 'icon-archive',
    reason: 'Appareil archivé : son agent n’existe plus'
};

export const OFFLINE: Unavailable = {
    icon: 'icon-x-circle',
    reason: 'Appareil hors ligne : la machine ne répond pas'
};

/**
 * Le premier motif qui s'applique, dans l'ordre où ils sont donnés. Cet ordre
 * est la règle : ce que le rôle interdit prime sur ce que l'état de la machine
 * empêche, parce que rallumer l'appareil ne changera rien au premier.
 */
export function firstReason(...reasons: (Unavailable | false | undefined)[]): Unavailable | undefined {
    return reasons.find((r): r is Unavailable => r !== false && r !== undefined);
}

/** Ce qui empêche de parler à l'agent, une fois la permission accordée. */
export function agentReach(device: Device): Unavailable | undefined {
    return firstReason(device.status === 'archived' && ARCHIVED, !device.online && OFFLINE);
}
