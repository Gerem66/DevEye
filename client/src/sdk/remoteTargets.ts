import { useMemo } from 'react';

import { ws, WsError, type DevEyeWs } from '@/api/ws';
import {
    ensureRemoteReady,
    isRemoteUsable,
    useRemoteInstances,
    useRemotePing,
    type RemoteEntry
} from '@/stores/remoteInstances';
import { useWorkspaceState, workspaceKey } from '@/stores/workspace';

/**
 * Les instances distantes du compte, vues comme cibles d'un envoi : ce qu'un
 * module peut viser hors de l'espace actif, et pourquoi il ne le peut pas
 * encore. Les deux serveurs ne se parlent pas : c'est ce navigateur qui porte
 * la commande à l'instance choisie, sur la socket qu'il y tient.
 */

/** Une instance distante du compte. */
export interface RemoteInstanceSummary {
    id: number;
    label: string;
    origin: string;
    /** Pourquoi rien ne peut lui être envoyé maintenant ; `null` quand on le peut. */
    unavailable: string | null;
}

/** Un espace d'une instance distante : la cible `{ instanceId, workspaceId }` d'un envoi. */
export interface RemoteWorkspaceTarget {
    /** Unique parmi les espaces de toutes les instances (`workspaceKey`). */
    key: string;
    instanceId: number;
    instanceLabel: string;
    instanceOrigin: string;
    workspaceId: number;
    workspaceName: string;
    /** Celui de son instance. */
    unavailable: string | null;
}

export interface RemoteTargets {
    instances: readonly RemoteInstanceSummary[];
    workspaces: readonly RemoteWorkspaceTarget[];
}

/** « non connecté » : une session à ouvrir là-bas ; « injoignable » : l'instance ne répond pas ou n'est pas à la même version. */
function unavailability(entry: RemoteEntry): string | null {
    if (entry.user === null) return 'non connecté';
    return isRemoteUsable(entry) ? null : 'injoignable';
}

/**
 * Les instances distantes du compte et leurs espaces, sondées tant que le
 * composant est monté. Hors session, les espaces sont ceux vus la dernière
 * fois : de quoi les nommer, pas les viser.
 */
export function useRemoteTargets(): RemoteTargets {
    const entries = useRemoteInstances();
    const { remoteWorkspaces } = useWorkspaceState();
    useRemotePing(true);
    return useMemo(() => {
        const instances = entries.map((entry) => ({
            id: entry.instance.id,
            label: entry.instance.label,
            origin: entry.instance.origin,
            unavailable: unavailability(entry)
        }));
        const workspaces = entries.flatMap((entry) => {
            const unavailable = unavailability(entry);
            const live = remoteWorkspaces[entry.instance.id] ?? [];
            const listed = live.length > 0 ? live : entry.known;
            return listed.map((w) => ({
                key: workspaceKey({ instanceId: entry.instance.id, id: w.id }),
                instanceId: entry.instance.id,
                instanceLabel: entry.instance.label,
                instanceOrigin: entry.instance.origin,
                workspaceId: w.id,
                workspaceName: w.name,
                unavailable
            }));
        });
        return { instances, workspaces };
    }, [entries, remoteWorkspaces]);
}

/**
 * La socket d'une instance du compte, `null` pour celle-ci ; une distante est
 * rouverte si elle s'est fermée. `closed` quand aucune session n'y est ouverte.
 */
export async function connectionTo(instanceId: number | null): Promise<DevEyeWs> {
    if (instanceId !== null) await ensureRemoteReady(instanceId);
    const conn = ws.connectionFor(instanceId);
    if (!conn) throw new WsError('closed', 'Cette instance est déconnectée.');
    return conn;
}
