import { useMemo } from 'react';
import type { CloudSyncShare, CloudSyncShareDevice } from 'deveye-types';

import { useDevices } from '@/stores/devices';

/**
 * Les appareils d'un partage, avec leur nom et leur présence PRIS SUR LE VIF.
 *
 * `cloudSync.listShares` embarque un `deviceName` et un `online` figés à
 * l'instant de la réponse. Rien ne les rafraîchit ensuite : renommer un
 * appareil, ou le voir revenir en ligne après une mise à jour de l'agent,
 * n'apparaissait qu'après un rechargement complet de la page. Or ces deux faits
 * ne sont pas la propriété du partage — ils appartiennent à l'appareil, et le
 * store `devices` les tient déjà à jour en direct.
 *
 * D'où le partage des rôles, qui est la seule chose à retenir ici :
 *  - le PARTAGE possède l'attache (dossier local, statut, dernière synchro) ;
 *  - le STORE possède l'appareil (nom, présence).
 *
 * On recompose au rendu au lieu de dupliquer, donc il n'y a rien à
 * ré-invalider : n'importe quel changement d'appareil se propage tout seul,
 * sans nouvel aller-retour et sans code de synchronisation à maintenir.
 *
 * Un appareil absent du store (retiré de l'espace, ou pas encore chargé) garde
 * les valeurs du partage : mieux vaut un nom un peu vieux qu'une ligne vide.
 */
export function useShareDevices(share: CloudSyncShare): CloudSyncShareDevice[] {
    const { devices } = useDevices();

    return useMemo(() => {
        const byId = new Map(devices.map((d) => [d.id, d] as const));
        return share.devices.map((attached) => {
            const live = byId.get(attached.deviceId);
            if (live === undefined) return attached;
            return { ...attached, deviceName: live.name, online: live.online };
        });
    }, [share.devices, devices]);
}

/**
 * Les appareils qu'on peut encore attacher à ce partage.
 *
 * Volontairement PAS filtré sur la présence. Un appareil hors ligne est un
 * choix parfaitement légitime — il rattrapera à sa prochaine connexion, c'est
 * tout le principe du merge 3 voies. Le filtrer donnait surtout une liste qui
 * changeait sous les doigts au gré des connexions, et faisait disparaître un
 * appareil qu'on venait de mettre à jour parce qu'il redémarrait justement.
 */
export function useAttachableDevices(share: CloudSyncShare) {
    const { devices } = useDevices();

    return useMemo(() => {
        const attached = new Set(share.devices.map((d) => d.deviceId));
        return devices.filter((d) => !attached.has(d.id));
    }, [share.devices, devices]);
}
