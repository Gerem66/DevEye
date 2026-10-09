import {
    DEPLOY_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    PROJECTS_USAGE_PROVIDER,
    type DeployActivity,
    type DeployItemsProvider,
    type GitItemsProvider,
    type ProjectsUsageProvider
} from '@deveye/types/sdk';
import type { SdkProviders } from '@deveye/types/sdk/server';

import type { UptimeDeploySource } from '../contracts/domain';

/**
 * L'acceptation d'une nouvelle version après un déploiement : ce que les
 * sources d'un service disent d'un écart. Aucun module ne prévient Uptime d'un
 * déploiement, c'est donc lui qui demande, au moment où il constate l'écart.
 */

/** Une fin de déploiement datée juste avant la dernière lecture conforme, qu'un cache servait encore. */
export const DEPLOY_MARGIN_SECONDS = 300;
/** Au-delà du rythme de lecture plus ceci, un déploiement n'explique plus un écart. */
export const DEPLOY_GRACE_SECONDS = 900;
/** L'attente d'un déploiement en cours, au plus : passé ce délai, l'écart redevient une alerte. */
export const DEPLOY_PENDING_MAX_SECONDS = 1800;
/** Pendant une attente, les fichiers se relisent à ce rythme au plus. */
export const DEPLOY_PENDING_RETRY_SECONDS = 60;

export type DeployEvidence =
    | { kind: 'deployed'; at: number; what: string }
    | { kind: 'inFlight'; what: string }
    | { kind: 'none'; errors: string[] };

/**
 * Le début de la fenêtre où un déploiement explique un écart : la dernière
 * lecture qui a retrouvé ou appris la référence, moins la marge. Une
 * acceptation automatique ne la déplace pas, pour qu'un cache qui livre la
 * nouvelle version en deux temps soit accepté deux fois par le même
 * déploiement ; le plancher borne ce report.
 */
export function deployWindowStart(anchor: number | null, now: number, integrityIntervalSeconds: number): number {
    const floor = now - integrityIntervalSeconds - DEPLOY_GRACE_SECONDS;
    return anchor === null ? floor : Math.max(anchor - DEPLOY_MARGIN_SECONDS, floor);
}

/**
 * Interroge les sources d'un service sur la fenêtre qui commence à `since` :
 * le succès le plus récent l'emporte, sinon un déploiement en cours, sinon rien
 * avec ce qui a empêché de savoir. Un projet vaut ses cibles et ses dépôts, et
 * une source dont le module manque reste muette.
 */
export async function findDeployEvidence(input: {
    sources: readonly UptimeDeploySource[];
    hookAt: number | null;
    workspaceId: number;
    since: number;
    providers: SdkProviders;
}): Promise<DeployEvidence> {
    const { sources, workspaceId, since, providers } = input;
    const deploy = providers.get<DeployItemsProvider>(DEPLOY_ITEMS_PROVIDER);
    const git = providers.get<GitItemsProvider>(GIT_ITEMS_PROVIDER);
    const projects = providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);

    const targets = new Set<number>();
    const repos = new Set<number>();
    for (const source of sources) {
        if (source.kind === 'deploy') targets.add(source.id);
        else if (source.kind === 'git') repos.add(source.id);
        else if (projects) {
            const linked = await projects.linkedItems(source.id, workspaceId);
            for (const id of linked.deploy) targets.add(id);
            for (const id of linked.git) repos.add(id);
        }
    }

    const answers = await Promise.allSettled([
        ...(deploy ? [...targets].map((id) => deploy.activity(id, workspaceId, since)) : []),
        ...(git ? [...repos].map((id) => git.activity(id, workspaceId, since)) : [])
    ]);
    const activities: DeployActivity[] = answers.map((answer) =>
        answer.status === 'fulfilled'
            ? answer.value
            : {
                  succeeded: null,
                  inFlight: null,
                  error: answer.reason instanceof Error ? answer.reason.message : String(answer.reason)
              }
    );
    if (input.hookAt !== null && input.hookAt >= since) {
        activities.push({ succeeded: { at: input.hookAt, what: 'l’adresse d’appel' }, inFlight: null, error: null });
    }

    let latest: { at: number; what: string } | null = null;
    for (const activity of activities) {
        if (activity.succeeded && (!latest || activity.succeeded.at > latest.at)) latest = activity.succeeded;
    }
    if (latest) return { kind: 'deployed', ...latest };
    const running = activities.find((a) => a.inFlight)?.inFlight;
    if (running) return { kind: 'inFlight', what: running.what };
    return { kind: 'none', errors: activities.flatMap((a) => (a.error ? [a.error] : [])) };
}
