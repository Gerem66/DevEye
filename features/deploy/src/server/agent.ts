import type { ContainerEngine, DockerInventory } from '@deveye/types';
import type { SdkDevice } from '@deveye/types/sdk/server';
import { FeatureError } from '@deveye/types/sdk/server';

import type { DeployCandidate, DeployMachine } from '../contracts/domain';

/**
 * Les cibles portées par une machine enrôlée : un service docker compose, que
 * son agent déploie en récupérant son image puis en le recréant seul
 * (`composeDeploy`). Rien ne se construit sur la machine ; aucun fournisseur
 * n'est sondé : l'agent rend lui-même le verdict et le journal.
 */

/** La capacité qu'un agent annonce quand il sait déployer. */
export const COMPOSE_DEPLOY_PROBE = 'composeDeploy';

/**
 * `moteur/projet/service`. Le même motif que l'agent (lettres, chiffres, `_`,
 * `-`, `.` après le premier caractère) : un nom refusé ici ne partirait pas.
 */
const SERVICE_ID = /^(docker|podman)\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;

export interface ComposeService {
    engine: ContainerEngine;
    project: string;
    service: string;
}

export function parseServiceId(externalId: string): ComposeService {
    const match = SERVICE_ID.exec(externalId);
    if (!match) {
        throw new FeatureError('validation', 'Service attendu sous la forme moteur/projet/service (docker/site/web).');
    }
    return { engine: match[1] as ContainerEngine, project: match[2], service: match[3] };
}

/** Ce que l'agent reçoit en cible : `projet/service`, le moteur voyageant à part. */
export function composeTargetOf(service: ComposeService): string {
    return `${service.project}/${service.service}`;
}

/**
 * Les services compose d'une machine, un par (moteur, projet, service) : un
 * service à trois répliques ne se déploie qu'une fois. Un conteneur lancé hors
 * compose n'a rien à redéployer.
 */
export function candidatesOf(inventory: DockerInventory): DeployCandidate[] {
    const seen = new Map<string, DeployCandidate>();
    for (const c of inventory.containers) {
        if (!c.composeProject || !c.composeService) continue;
        const externalId = `${c.engine}/${c.composeProject}/${c.composeService}`;
        if (!SERVICE_ID.test(externalId) || seen.has(externalId)) continue;
        seen.set(externalId, {
            kind: 'service',
            externalId,
            name: c.composeService,
            path: `${c.composeProject} · ${c.image}`,
            ref: null
        });
    }
    return [...seen.values()].sort(
        (a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.name.localeCompare(b.name)
    );
}

/** Une machine telle que le choix d'une cible la montre. */
export function machineOf(device: SdkDevice): DeployMachine {
    const agent = device.report?.agent ?? null;
    return {
        id: device.id,
        name: device.name,
        online: device.online,
        capable: agent?.probes.includes(COMPOSE_DEPLOY_PROBE) ?? false,
        // Un déploiement est une action Docker : la machine doit permettre les deux.
        allowed: agent ? agent.policy.docker && agent.policy.dockerDeploy : true
    };
}
