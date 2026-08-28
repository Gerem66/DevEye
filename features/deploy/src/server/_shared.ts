import type {
    DeployCredential,
    DeployCredentialRow,
    Deployment,
    DeploymentRow,
    DeployTarget,
    DeployTargetRow
} from '../contracts/domain';
import { deployTargetSchema } from '../contracts/domain';
import { PROJECTS_USAGE_PROVIDER, type ProjectsUsageProvider } from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { DeployRepo, DeployTargetWithUsageRow } from './repo';
import type { DeploySync } from './service';

/**
 * Le socle de la feature Déploiement.
 *
 * **Un seul chiffre, toujours l'étage ouvert**, exactement comme la feature Git
 * et pour la même raison : une cible appartient à l'espace et peut servir
 * plusieurs projets de paliers différents, elle ne peut donc suivre aucun d'eux.
 * Corollaire pratique : rien ici ne demande jamais de mot de passe, et le suivi
 * d'état lit tout sans session — ce dont il a précisément besoin. `ctx.cipher()`
 * est cet étage (l'ex `ctx.secure.open`, que `deployCipher` enveloppait).
 */

/** Le contexte d'une commande de Déploiement : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<DeployRepo>;

/** Ce que porte `deploy_targets.content`, chiffré. */
export interface StoredTarget {
    name: string;
}

/** Ce que porte `deployments.content`, chiffré. */
export interface StoredDeployment {
    title: string;
    description: string;
    url: string | null;
    /**
     * Les messages Discord qui suivent ce déploiement en direct, **un par
     * canal** : `identifiant de canal → identifiant de message`.
     *
     * C'était une seule chaîne tant qu'un espace n'avait qu'un webhook. Depuis
     * que les canaux sont une liste, un déploiement peut être suivi dans deux
     * salons à la fois, et chacun a son propre message à modifier — les
     * confondre ferait éditer, dans le second salon, un identifiant qui
     * appartient au premier.
     *
     * Dans le blob et non dans une colonne : jamais un critère de recherche,
     * seulement une donnée transportée avec la ligne, et le blob est déjà
     * réécrit à chaque changement d'état.
     *
     * **Persisté, et c'est le point** : un serveur redémarré au milieu d'un
     * déploiement retrouve les messages qu'il avait ouverts et continue de les
     * modifier, au lieu d'en poser de seconds à côté.
     */
    noticeIds?: Record<string, string> | null;
}

/**
 * Le suivi de fond du module, posé par `createService` au démarrage : le
 * remplaçant de la moitié déploiement de l'`IntegrationSyncService` natif,
 * que `ctx.integrations` prêtait aux handlers. Un singleton d'étendue module,
 * assumé (patron `setEngine` de CloudSync) : le rapprochement est unique par
 * processus, exactement comme avant le rapatriement.
 */
let syncRef: DeploySync | null = null;

export function setSync(sync: DeploySync | null): void {
    syncRef = sync;
}

/**
 * Réveille le suivi de fond, s'il est monté.
 *
 * Sert au déclenchement d'un déploiement : il n'y a rien à synchroniser côté
 * git, seulement un suivi d'état à reprendre plus tôt que la cadence. C'est
 * aussi ce qui ouvre le message de suivi dans la seconde qui suit un
 * déclenchement parti d'ici, sans attendre le prochain battement.
 *
 * Tolérant à l'absence du service (tests, boot en cours), comme l'était
 * `ctx.integrations?.wake()` : le prochain battement fera le même travail.
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
 * Une cible visible depuis cet espace — la sienne, ou une que l'on y projette.
 *
 * C'est **la** frontière d'espace de la feature : toute commande qui prend un
 * `targetId` commence par là. `level` décide de la garde : `ctx.items.assert`
 * (l'ex `assertItem`) refuse en plus les cibles qu'une restriction de rôle
 * masque ou passe en lecture seule.
 */
export async function loadTarget(
    ctx: Ctx,
    targetId: number,
    level: 'read' | 'write' = 'read'
): Promise<DeployTargetRow> {
    const row = await ctx.repo.findVisibleTarget(targetId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
    await ctx.items.assert(targetId, level);
    return row;
}

/**
 * Comme {@link loadTarget}, mais exige que la cible soit **chez l'appelant**.
 *
 * Pour les gestes réservés au domicile : la modifier (son jeton se choisit
 * parmi les clés d'ici, pas de là-bas) et la supprimer. Une fenêtre lit,
 * déclenche et suit ; elle ne reconfigure pas la donnée d'un autre espace.
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
 * Le codec d'une cible **là où elle vit**.
 *
 * Une cible projetée reste chiffrée sous la clé de son espace d'origine, et la
 * relire avec celle d'ici rendrait un nom vide qu'on croirait mal enregistré.
 * `ctx.sharing.scope()` est l'ex `shareScope(ctx, 'deploy')` : `cipherFor` ne
 * rend un codec étranger que si la projection existe réellement.
 */
export async function targetCipherFor(ctx: Ctx, row: Pick<DeployTargetRow, 'id' | 'workspace_id'>): Promise<SdkCipher> {
    if (row.workspace_id === ctx.workspaceId) return ctx.cipher();
    const scope = await ctx.sharing.scope();
    return scope.cipherFor(row.id);
}

export async function toTarget(
    cipher: SdkCipher,
    row: DeployTargetWithUsageRow,
    foreign: boolean,
    /** Le nombre de projets qui la déploient, venu du contrat de Projets. */
    projectCount: number
): Promise<DeployTarget> {
    const body = await readJson<Partial<StoredTarget>>(cipher, row.content);
    return deployTargetSchema.parse({
        foreign,
        id: row.id,
        provider: 'dokploy',
        kind: row.target_kind === 'compose' ? 'compose' : 'application',
        externalId: row.external_id,
        // Repli sur l'identifiant externe : une cible dont le corps serait
        // illisible reste désignable, plutôt que de s'afficher sans nom.
        name: body?.name ?? row.external_id,
        credentialId: row.credential_id,
        baseUrl: row.base_url,
        lastStatus: normalizeStatus(row.last_status),
        lastDeployAt: row.last_deploy_at === null ? null : Number(row.last_deploy_at),
        projectCount,
        created: Number(row.created)
    });
}

/**
 * Recharge une cible avec son usage, pour la rendre au client.
 *
 * Une requête de plus après chaque écriture, assumée : sans elle, `projectCount`
 * et l'état du dernier déploiement seraient absents ou devinés, et la liste
 * afficherait « 0 projet » sur une cible qui en sert trois — un chiffre faux est
 * pire qu'un aller-retour.
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

/**
 * Une clé Dokploy telle que le client la voit : jamais son secret, seulement
 * sa présence. Un secret qu'on ne renvoie pas est un secret qui ne peut fuiter
 * ni par une capture d'écran ni par un journal.
 */
export function toCredential(row: DeployCredentialRow, useCount: number): DeployCredential {
    return {
        id: row.id,
        label: row.label,
        baseUrl: row.base_url,
        hasSecret: row.secret_enc.length > 0,
        created: row.created,
        useCount
    };
}

/**
 * Charge une clé Dokploy utilisable, ou explique ce qui manque.
 *
 * L'adresse de l'instance vit sur le jeton et non sur la cible : deux cibles de
 * la même instance ne peuvent donc pas en donner deux versions différentes, et
 * déménager une instance se règle en un seul endroit.
 */
export async function loadDokployCredential(
    ctx: Ctx,
    credentialId: number,
    /**
     * La cible pour laquelle on charge la clé, quand elle peut être projetée :
     * son jeton vit dans **son** espace, et le chercher ici répondrait
     * « introuvable » sur une cible parfaitement configurée. Absent = la clé
     * de l'espace actif (déclaration, sélecteur de candidats).
     */
    target?: DeployTargetRow
): Promise<{ baseUrl: string; apiKey: string }> {
    const home = target?.workspace_id ?? ctx.workspaceId;
    const credential = await ctx.repo.findCredential(credentialId, home);
    if (!credential) throw new FeatureError('not_found', 'Accès Dokploy introuvable');
    if (!credential.base_url) {
        throw new FeatureError('validation', 'Cet accès Dokploy n’a pas d’adresse d’instance.');
    }
    // Le codec du **domicile**, étage ouvert toujours : le suivi tourne sans
    // session, et le secret d'une cible projetée est scellé sous la clé de son
    // espace. `cipherFor(target.id)` ne rend un codec étranger que si la
    // projection existe réellement : la garde du SDK.
    const cipher = target ? await targetCipherFor(ctx, target) : ctx.cipher();
    return { baseUrl: credential.base_url, apiKey: await cipher.decrypt(credential.secret_enc) };
}

/**
 * Le contrat de Projets, relu à l'appel : offert par l'app tant que Projets
 * est native, par son module ensuite ; d'ici, aucune différence. Absent (rien
 * n'offre la clé), la feature dégrade proprement : zéro projet partout, aucune
 * commande ne casse.
 */
export function projectsProvider(ctx: Pick<Ctx, 'providers'>): ProjectsUsageProvider | undefined {
    return ctx.providers.get<ProjectsUsageProvider>(PROJECTS_USAGE_PROVIDER);
}

/**
 * Combien de projets de l'espace **appelant** déploient chaque cible.
 *
 * Le module ne lit aucune table de Projets : le compte vient de son contrat,
 * et les projets comptés sont ceux d'ICI, les mêmes que `deploy.get` liste
 * (une cible projetée montre les projets de la fenêtre, pas ceux de son
 * domicile).
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
 * Inscrit le déclenchement dans la frise du projet d'où il est parti.
 *
 * Traverse la frontière des deux modules, et c'est assumé : c'est le seul point
 * où le déploiement a quelque chose à dire à un projet. Le passage par le
 * contrat de Projets (`recordEvent`) plutôt que par ses tables tient le module
 * à sa place, et **ne lève jamais** : le déploiement a déjà eu lieu, perdre
 * une ligne de frise ne doit pas le transformer en échec. Sans contrat (rien
 * n'offre la clé), la frise n'est simplement pas écrite.
 */
export async function recordProjectEvent(ctx: Ctx, projectId: number, title: string): Promise<void> {
    try {
        await projectsProvider(ctx)?.recordEvent(projectId, ctx.workspaceId, {
            kind: 'deploy.triggered',
            label: title,
            actorUserId: ctx.userId
        });
    } catch (e) {
        ctx.logger.warn({ err: e, projectId }, 'deploy: événement de frise non enregistré');
    }
}
