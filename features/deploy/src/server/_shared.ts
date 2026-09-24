import type {
    DeployCredential,
    DeployCredentialRow,
    Deployment,
    DeploymentRow,
    DeployTarget,
    DeployTargetKind,
    DeployTargetRow
} from '../contracts/domain';
import { deployCredentialProviderSchema, deployTargetKindSchema, deployTargetSchema } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import { PROVIDERS, providerOf } from './providers';
import type { DeployProviderAdapter, ProviderAccess, ProviderTarget } from './providers/types';
import type { DeployRepo, DeployTargetWithUsageRow } from './repo';
import type { DeploySync } from './service';

/**
 * Le socle de la feature Déploiement. Un seul chiffre, toujours l'étage ouvert :
 * une cible appartient à l'espace et peut servir plusieurs projets de paliers
 * différents. Rien ici ne demande de mot de passe, et le suivi d'état lit tout
 * sans session ; `ctx.cipher()` est cet étage.
 */

export type Ctx = SdkFeatureContext<DeployRepo>;

/** Ce que porte `deploy_targets.content`, chiffré. */
export interface StoredTarget {
    name: string;
    /** La branche d'un workflow ; absente ailleurs. */
    ref?: string | null;
}

/** Ce que porte `deployments.content`, chiffré. */
export interface StoredDeployment {
    title: string;
    description: string;
    url: string | null;
    /**
     * Les messages Discord qui suivent ce déploiement, un par canal
     * (`identifiant de canal → identifiant de message`). Persisté : un serveur
     * redémarré en cours de route reprend les mêmes messages au lieu d'en poser
     * de seconds.
     */
    noticeIds?: Record<string, string> | null;
}

/** Le suivi de fond du module, posé par `createService` : un singleton par processus. */
let syncRef: DeploySync | null = null;

export function setSync(sync: DeploySync | null): void {
    syncRef = sync;
}

/**
 * Réveille le suivi de fond, s'il est monté : un déclenchement n'attend pas la
 * cadence pour ouvrir son message de suivi. Tolère l'absence du service (tests,
 * boot en cours) : le prochain battement fera le travail.
 */
export function wakeSync(): void {
    syncRef?.wake();
}

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: SdkCipher, blob: string | null): Promise<T | null> {
    if (!blob) return null;
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as T;
    } catch {
        return null;
    }
}

/**
 * Une cible visible depuis cet espace : la sienne, ou une qu'on y projette.
 * La frontière d'espace de la feature : toute commande qui prend un `targetId`
 * commence par là. `ctx.items.assert` refuse en plus les cibles qu'une
 * restriction de rôle masque ou passe en lecture seule.
 */
export async function loadTarget(
    ctx: Ctx,
    targetId: number,
    level: 'read' | 'write' = 'read'
): Promise<DeployTargetRow> {
    const row = await ctx.repo.findVisibleTarget(targetId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
    await ctx.items.assert(String(targetId), level);
    return row;
}

/**
 * Comme {@link loadTarget}, mais exige que la cible soit chez l'appelant : la
 * modifier et la supprimer sont réservés au domicile. Une fenêtre lit,
 * déclenche et suit.
 */
export async function loadHomeTarget(ctx: Ctx, targetId: number): Promise<DeployTargetRow> {
    const row = await loadTarget(ctx, targetId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Cette cible appartient à un autre espace : elle se modifie et se supprime depuis là-bas.'
        );
    }
    return row;
}

/**
 * Le codec d'une cible là où elle vit : une cible projetée reste chiffrée sous
 * la clé de son espace d'origine. `cipherFor` ne rend un codec étranger que si
 * la projection existe réellement.
 */
export async function targetCipherFor(ctx: Ctx, row: Pick<DeployTargetRow, 'id' | 'workspace_id'>): Promise<SdkCipher> {
    if (row.workspace_id === ctx.workspaceId) return ctx.cipher();
    const scope = await ctx.sharing.scope();
    return scope.cipherFor(String(row.id));
}

/** Le type d'une cible tel qu'écrit en base ; un type inconnu vaut application, le défaut de la colonne. */
export function kindOf(row: Pick<DeployTargetRow, 'target_kind'>): DeployTargetKind {
    const parsed = deployTargetKindSchema.safeParse(row.target_kind);
    return parsed.success ? parsed.data : 'application';
}

/** Ce qu'une cible désigne chez son fournisseur, sa branche lue dans son corps déchiffré. */
export function providerTargetOf(
    row: Pick<DeployTargetRow, 'target_kind' | 'external_id'>,
    body: Partial<StoredTarget> | null
): ProviderTarget {
    return { kind: kindOf(row), externalId: row.external_id, ref: body?.ref ?? null };
}

export async function toTarget(
    cipher: SdkCipher,
    row: DeployTargetWithUsageRow,
    foreign: boolean,
    /** Le nombre de projets qui la déploient, venu du contrat de Projets. */
    projectCount: number
): Promise<DeployTarget> {
    const body = await readJson<Partial<StoredTarget>>(cipher, row.content);
    const provider = deployCredentialProviderSchema.catch('dokploy').parse(row.provider);
    const target = providerTargetOf(row, body);
    return deployTargetSchema.parse({
        foreign,
        id: row.id,
        provider,
        kind: target.kind,
        externalId: row.external_id,
        // Repli sur l'identifiant externe : une cible dont le corps serait
        // illisible reste désignable, plutôt que de s'afficher sans nom.
        name: body?.name ?? row.external_id,
        credentialId: row.credential_id,
        location: PROVIDERS[provider].location({ baseUrl: row.base_url }, target),
        ref: target.ref,
        lastStatus: normalizeStatus(row.last_status),
        lastDeployAt: row.last_deploy_at === null ? null : Number(row.last_deploy_at),
        projectCount,
        created: Number(row.created)
    });
}

/**
 * Recharge une cible avec son usage, pour la rendre au client : sans cette
 * relecture, `projectCount` et l'état du dernier déploiement seraient devinés.
 */
export async function reloadTarget(ctx: Ctx, targetId: number): Promise<DeployTarget> {
    const row = await ctx.repo.findVisibleTargetWithUsage(targetId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
    const counts = await projectCountsOf(ctx);
    return toTarget(
        await targetCipherFor(ctx, row),
        row,
        row.workspace_id !== ctx.workspaceId,
        counts.get(targetId) ?? 0
    );
}

/** Un état venu de la base : inconnu vaut `null`, jamais une valeur inventée. */
function normalizeStatus(raw: string | null): Deployment['status'] | null {
    if (raw === 'success' || raw === 'failed' || raw === 'running' || raw === 'queued') return raw;
    return null;
}

export async function toDeployment(cipher: SdkCipher, row: DeploymentRow): Promise<Deployment> {
    const body = await readJson<Partial<StoredDeployment>>(cipher, row.content);
    return {
        id: row.id,
        targetId: row.target_id,
        externalId: row.external_id,
        status: normalizeStatus(row.status) ?? 'queued',
        triggeredByUserId: row.triggered_by_user_id,
        title: body?.title ?? '',
        description: body?.description ?? '',
        url: body?.url || null,
        startedAt: Number(row.started_at),
        finishedAt: row.finished_at === null ? null : Number(row.finished_at)
    };
}

/** Un accès tel que le client le voit : jamais son secret, seulement sa présence. */
export function toCredential(row: DeployCredentialRow, useCount: number): DeployCredential {
    return {
        id: row.id,
        provider: deployCredentialProviderSchema.catch('dokploy').parse(row.provider),
        label: row.label,
        baseUrl: row.base_url,
        hasSecret: row.secret_enc.length > 0,
        created: row.created,
        useCount
    };
}

/**
 * Charge un accès utilisable et son fournisseur, ou explique ce qui manque.
 * L'adresse d'une instance vit sur l'accès, pas sur la cible.
 */
export async function loadAccess(
    ctx: Ctx,
    credentialId: number,
    /**
     * La cible pour laquelle on charge l'accès, quand elle peut être projetée :
     * son jeton vit dans SON espace. Absent = l'accès de l'espace actif.
     */
    target?: DeployTargetRow
): Promise<{ provider: DeployProviderAdapter; access: ProviderAccess }> {
    const home = target?.workspace_id ?? ctx.workspaceId;
    const credential = await ctx.repo.findCredential(credentialId, home);
    if (!credential) throw new FeatureError('not_found', 'Accès de déploiement introuvable');
    const provider = providerOf(PROVIDERS, credential.provider);
    if (provider.id === 'dokploy' && !credential.base_url) {
        throw new FeatureError('validation', 'Cet accès Dokploy n’a pas d’adresse d’instance.');
    }
    // Le codec du domicile, étage ouvert : le secret d'une cible projetée est
    // scellé sous la clé de son espace.
    const cipher = target ? await targetCipherFor(ctx, target) : ctx.cipher();
    return {
        provider,
        access: { credentialId, baseUrl: credential.base_url, secret: await cipher.decrypt(credential.secret_enc) }
    };
}

/**
 * Le contrat de Projets, relu à l'appel. Absent, la feature dégrade proprement :
 * zéro projet partout, aucune commande ne casse.
 */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/**
 * Combien de projets de l'espace appelant déploient chaque cible. Le module ne
 * lit aucune table de Projets : le compte vient de son contrat, et une cible
 * projetée montre les projets de la fenêtre, pas ceux de son domicile.
 */
export async function projectCountsOf(ctx: Ctx): Promise<ReadonlyMap<number, number>> {
    return (await projectsProvider(ctx)?.countByItem('deploy', ctx.workspaceId)) ?? new Map<number, number>();
}

/**
 * Les projets de l'espace appelant qui déploient cette cible : la fiche
 * d'une cible projetée montre les projets d'ici qui la déploient, pas ceux de
 * là-bas.
 */
export async function projectIdsOf(ctx: Ctx, targetId: number): Promise<number[]> {
    const usage = (await projectsProvider(ctx)?.usageOf('deploy', targetId, ctx.workspaceId)) ?? [];
    return usage.map((u) => u.projectId);
}

/**
 * Inscrit le déclenchement dans la frise du projet d'où il est parti, par le
 * contrat de Projets. Ne lève jamais : le déploiement a déjà eu lieu, perdre
 * une ligne de frise ne doit pas le transformer en échec.
 */
export async function recordProjectEvent(
    ctx: Ctx,
    projectId: number,
    workspaceId: number,
    title: string
): Promise<void> {
    try {
        // L'espace de la CIBLE, pas celui de l'appelant : un projet ne relie
        // qu'une cible de son propre espace, donc la frise vit là où la cible
        // vit, même quand le geste part d'une fenêtre sur elle.
        await projectsProvider(ctx)?.recordEvent(projectId, workspaceId, {
            kind: 'deploy.triggered',
            label: title,
            actorUserId: ctx.userId
        });
    } catch (e) {
        ctx.logger.warn({ err: e, projectId }, 'deploy: événement de frise non enregistré');
    }
}
