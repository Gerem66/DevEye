import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import type {
    UptimeDeployCandidate,
    UptimeDeployCandidateKind,
    UptimeDeploySource,
    UptimeDeploySourceKind
} from '../contracts/domain';
import {
    DEPLOY_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    PROJECTS_USAGE_PROVIDER,
    type DeployItemsProvider,
    type GitItemsProvider,
    type ItemCandidate,
    type ProjectsUsageProvider
} from '@deveye/types/sdk';
import {
    FeatureError,
    type FeatureServiceDeps,
    type SdkAccessVerdict,
    type SdkCipher,
    type SdkProviders,
    type SdkPublicApp
} from '@deveye/types/sdk/server';

import type { UptimeRepo } from './repo';
import type { UptimeMonitor } from './service';

/**
 * Les sources de déploiement d'un service : les éléments d'autres features
 * qu'il désigne (projets, cibles de Déploiements, dépôts Git), choisis dans
 * l'espace d'origine du service, et son adresse d'appel.
 */

/** Le chemin que la CI d'un site appelle après une mise en ligne, suivi du jeton. */
export const DEPLOY_HOOK_PATH = '/api/uptime/deployed';

/** Deux appels rapprochés (une CI qui relance) ne relisent le site qu'une fois. */
const DEPLOY_HOOK_COOLDOWN_SECONDS = 60;

export function deployHookUrl(publicOrigin: string, token: string): string {
    return `${publicOrigin}${DEPLOY_HOOK_PATH}/${token}`;
}

export function deployHookHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/** Un jeton neuf : son condensat pour la recherche, et lui-même scellé pour le réafficher. */
export async function newDeployHook(cipher: SdkCipher): Promise<{ token: string; hash: string; enc: string }> {
    const token = randomBytes(24).toString('base64url');
    return { token, hash: deployHookHash(token), enc: await cipher.encrypt(token) };
}

export const DEPLOY_CANDIDATE_KINDS: readonly UptimeDeployCandidateKind[] = ['project', 'deploy', 'git', 'hook'];

/** Un refus qui dit que l'élément n'existe pas pour l'appelant : il ne se montre pas. */
const UNSEEN = new Set(['hidden', 'not_member', 'suspended']);

const NAMES: Record<UptimeDeploySourceKind, { module: string; refusal: string }> = {
    project: { module: 'Projets', refusal: 'Vous n’avez pas accès à ce projet.' },
    deploy: { module: 'Déploiements', refusal: 'Vous n’avez pas accès à cette cible.' },
    git: { module: 'Git', refusal: 'Vous n’avez pas accès à ce dépôt.' }
};

interface SourceAccess {
    list(workspaceId: number): Promise<readonly ItemCandidate[]>;
    authorize(id: number, workspaceId: number, userId: number): Promise<SdkAccessVerdict>;
}

/** Ce que le module d'une catégorie offre, `null` quand il n'est pas installé. */
function accessOf(providers: SdkProviders, kind: UptimeDeploySourceKind, serviceId: number): SourceAccess | null {
    if (kind === 'deploy') return providers.get<DeployItemsProvider>(DEPLOY_ITEMS_PROVIDER) ?? null;
    if (kind === 'git') return providers.get<GitItemsProvider>(GIT_ITEMS_PROVIDER) ?? null;
    const projects = providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
    if (!projects) return null;
    return {
        // Les vivants, et un rangé seulement s'il relie déjà le service.
        list: async (workspaceId) =>
            (await projects.linkTargets('uptime', serviceId, workspaceId))
                .filter((p) => !p.archived)
                .map((p) => ({ id: p.projectId, name: p.title, detail: p.linked ? 'Relié à ce service' : null })),
        authorize: (id, workspaceId, userId) => projects.authorize(id, workspaceId, userId)
    };
}

const keyOf = (source: Pick<UptimeDeploySource, 'kind' | 'id'>) => `${source.kind}:${source.id}`;

/**
 * Le sélecteur : chaque catégorie, même vide, ses éléments que le membre voit,
 * grisés quand il ne peut pas les choisir. Une source déjà choisie reste
 * cochable pour qu'on la retire, même disparue ou hors de ses droits.
 */
export async function deployCandidates(input: {
    providers: SdkProviders;
    serviceId: number;
    workspaceId: number;
    userId: number;
    chosen: readonly UptimeDeploySource[];
}): Promise<UptimeDeployCandidate[]> {
    const chosen = new Set(input.chosen.map(keyOf));
    const candidates: UptimeDeployCandidate[] = [];
    for (const kind of ['project', 'deploy', 'git'] as const) {
        const access = accessOf(input.providers, kind, input.serviceId);
        const items = access ? await access.list(input.workspaceId) : [];
        const listed = new Set<number>();
        for (const item of items) {
            const isChosen = chosen.has(keyOf({ kind, id: item.id }));
            const verdict = await access!.authorize(item.id, input.workspaceId, input.userId);
            const unseen = !verdict.ok && UNSEEN.has(verdict.reason);
            if (unseen && !isChosen) continue;
            listed.add(item.id);
            candidates.push({
                kind,
                id: item.id,
                name: unseen ? 'Source masquée' : item.name,
                detail: unseen ? null : item.detail,
                available: verdict.ok || isChosen,
                tag: verdict.ok ? null : 'sans droit',
                reason: verdict.ok
                    ? null
                    : unseen
                      ? 'Vous ne la voyez pas : elle reste active tant qu’on ne la retire pas.'
                      : NAMES[kind].refusal
            });
        }
        for (const source of input.chosen) {
            if (source.kind !== kind || listed.has(source.id)) continue;
            candidates.push({
                kind,
                id: source.id,
                name: 'Source introuvable',
                detail: null,
                available: true,
                tag: 'introuvable',
                reason: access
                    ? 'Elle n’existe plus dans cet espace : décochez-la.'
                    : `Le module ${NAMES[kind].module} n’est pas installé.`
            });
        }
    }
    candidates.push({
        kind: 'hook',
        id: null,
        name: 'Adresse d’appel de ce service',
        detail: 'toute autre CI',
        available: true,
        tag: null,
        reason: null
    });
    return candidates;
}

/**
 * Refuse une source AJOUTÉE que l'appelant ne peut pas lire, dans l'espace
 * d'origine du service. Celles déjà en place restent : un autre membre les a
 * choisies, et les retirer en silence changerait ce que le service accepte.
 */
export async function assertNewDeploySources(input: {
    providers: SdkProviders;
    serviceId: number;
    workspaceId: number;
    userId: number;
    sources: readonly UptimeDeploySource[];
    previous: readonly UptimeDeploySource[];
}): Promise<void> {
    const before = new Set(input.previous.map(keyOf));
    for (const source of input.sources) {
        if (before.has(keyOf(source))) continue;
        const access = accessOf(input.providers, source.kind, input.serviceId);
        if (!access) throw new FeatureError('validation', `Le module ${NAMES[source.kind].module} n’est pas installé.`);
        const verdict = await access.authorize(source.id, input.workspaceId, input.userId);
        if (verdict.ok) continue;
        if (UNSEEN.has(verdict.reason)) {
            throw new FeatureError('not_found', 'Une source choisie n’existe pas dans l’espace de ce service.');
        }
        throw new FeatureError('forbidden', NAMES[source.kind].refusal);
    }
}

const hookParams = z.object({ token: z.string().min(16).max(128) });

/**
 * L'adresse d'appel : la CI d'un site la frappe après une mise en ligne. Le
 * moment est retenu pour expliquer l'écart qui suit, et les fichiers sont
 * relus sur-le-champ, sans faire attendre la CI.
 */
export function registerDeployHook(
    app: SdkPublicApp,
    deps: Pick<FeatureServiceDeps<UptimeRepo>, 'repo'>,
    monitor: Pick<UptimeMonitor, 'runOne'>
): void {
    app.post(
        `${DEPLOY_HOOK_PATH}/:token`,
        { rateLimit: { max: 30, timeWindow: '1 minute' }, bodyLimit: 1024 },
        async (req, reply) => {
            const parsed = hookParams.safeParse(req.params);
            const row = parsed.success
                ? await deps.repo.services.findByDeployHook(deployHookHash(parsed.data.token))
                : null;
            if (!row || row.integrity_interval_seconds === null) {
                return reply.code(404).send({ error: 'Adresse d’appel inconnue.' });
            }
            const now = Math.floor(Date.now() / 1000);
            const fresh = row.deploy_hook_at === null || now - row.deploy_hook_at >= DEPLOY_HOOK_COOLDOWN_SECONDS;
            await deps.repo.services.markDeployHookCalled(row.id, now);
            if (fresh && row.enabled === 1) void monitor.runOne({ ...row, deploy_hook_at: now }, { readFiles: true });
            return reply.code(204).send();
        }
    );
}
