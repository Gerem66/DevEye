import {
    agentDockerAction,
    agentDockerInventory,
    agentDockerStats,
    isLongDockerAction,
    isUntargetedDockerAction,
    type DockerAction
} from '@deveye/types';

import { authorizeReachableDevice } from '@/agent/authorize';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * Le transport des ordres conteneurs. Une seule permission, `docker`, comme
 * `files` couvre parcourir et supprimer : le modèle de permissions du projet ne
 * découpe pas par verbe. Ce qu'elle recouvre est dit dans le manifest.
 */

/** Ce que l'action inflige, pour le ton de la trace d'audit. */
const DESTRUCTIVE: ReadonlySet<DockerAction> = new Set<DockerAction>([
    'removeContainer',
    'removeImage',
    'removeVolume',
    'removeNetwork',
    'pruneContainers',
    'pruneImages',
    'pruneVolumes',
    'pruneNetworks',
    'pruneBuildCache',
    'recreate',
    'composeDeploy'
]);

export const agentDockerInventoryFeature: FeatureDefinition<
    typeof agentDockerInventory.command,
    typeof agentDockerInventory.input,
    typeof agentDockerInventory.output
> = defineFeature({
    ...agentDockerInventory,
    access: { feature: 'devices', extras: ['docker'] },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestDockerInventory(row.id) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

export const agentDockerStatsFeature: FeatureDefinition<
    typeof agentDockerStats.command,
    typeof agentDockerStats.input,
    typeof agentDockerStats.output
> = defineFeature({
    ...agentDockerStats,
    access: { feature: 'devices', extras: ['docker'] },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestDockerStats(row.id) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

export const agentDockerActionFeature: FeatureDefinition<
    typeof agentDockerAction.command,
    typeof agentDockerAction.input,
    typeof agentDockerAction.output
> = defineFeature({
    ...agentDockerAction,
    access: { feature: 'devices', extras: ['docker'] },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const monitor = ctx.monitor;
        if (!monitor) throw new FeatureError('conflict', 'Agent hors ligne');

        const target = input.target ?? null;
        // Les nettoyages portent sur le moteur entier, les autres sur un objet :
        // se tromper de forme viserait la mauvaise chose, ou rien.
        if (isUntargetedDockerAction(input.action)) {
            if (target !== null) throw new FeatureError('validation', 'Cette action ne prend aucune cible');
        } else if (!target) {
            throw new FeatureError('validation', 'Cette action demande une cible');
        }

        // Le verrou d'abord, comme pour les paquets : la seule barrière qui
        // tienne quel que soit l'écran du second clic. Relâché par `docker.done`,
        // ou d'autorité si l'agent s'en va.
        const long = isLongDockerAction(input.action);
        if (long && !monitor.beginDockerOp(row.id, input.opId, input.action)) {
            throw new FeatureError('conflict', 'Une action est déjà en cours sur cet appareil');
        }
        if (!monitor.requestDockerAction(row.id, { ...input, target })) {
            if (long) monitor.endDockerOp(row.id, input.opId);
            throw new FeatureError('conflict', 'Agent hors ligne');
        }

        ctx.audit({
            action: 'agent.dockerAction',
            level: DESTRUCTIVE.has(input.action) ? 'warning' : 'info',
            description: `Action conteneur « ${input.action} » : « ${row.name} »`,
            metadata: {
                deviceId: row.id,
                ownerId: row.owner_id,
                engine: input.engine,
                dockerAction: input.action,
                target
            }
        });
        return { ok: true };
    }
});
