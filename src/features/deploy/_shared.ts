import type { DeployTarget, DeployTargetRow, Deployment, DeploymentRow } from 'deveye-types';
import { deployTargetSchema } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import type { DeployTargetWithUsageRow } from 'deveye-types';
import { FeatureError, type FeatureContext } from '../_define';
import { shareScope } from '../_sharing';

/**
 * Le socle de la feature Déploiement.
 *
 * **Un seul chiffre, toujours l'étage ouvert**, exactement comme la feature Git
 * et pour la même raison : une cible appartient à l'espace et peut servir
 * plusieurs projets de paliers différents, elle ne peut donc suivre aucun d'eux.
 * Corollaire pratique : rien ici ne demande jamais de mot de passe, et le suivi
 * d'état lit tout sans session — ce dont il a précisément besoin.
 */
export function deployCipher(ctx: FeatureContext): Cipher {
    return ctx.secure.open;
}

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

/** Déchiffre et parse, sans jamais lever : `null` dit simplement « illisible ». */
export async function readJson<T>(cipher: Cipher, blob: string | null): Promise<T | null> {
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
 * `targetId` commence par là. `level` décide de la garde : `assertItem` refuse
 * en plus les cibles qu'une restriction de rôle masque ou passe en lecture
 * seule.
 */
export async function loadTarget(
    ctx: FeatureContext,
    targetId: number,
    level: 'read' | 'write' = 'read'
): Promise<DeployTargetRow> {
    const row = await ctx.db.deploy.findVisibleTarget(targetId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
    await ctx.assertItem('deploy', targetId, level);
    return row;
}

/**
 * Comme {@link loadTarget}, mais exige que la cible soit **chez l'appelant**.
 *
 * Pour les gestes réservés au domicile : la modifier (son jeton se choisit
 * parmi les clés d'ici, pas de là-bas) et la supprimer. Une fenêtre lit,
 * déclenche et suit ; elle ne reconfigure pas la donnée d'un autre espace.
 */
export async function loadHomeTarget(ctx: FeatureContext, targetId: number): Promise<DeployTargetRow> {
    const row = await loadTarget(ctx, targetId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Cette cible appartient à un autre espace : elle se modifie et se supprime depuis là-bas.'
        );
    }
    return row;
}

export async function toTarget(cipher: Cipher, row: DeployTargetWithUsageRow, foreign: boolean): Promise<DeployTarget> {
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
        projectCount: Number(row.project_count),
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
export async function reloadTarget(ctx: FeatureContext, targetId: number): Promise<DeployTarget> {
    const row = await ctx.db.deploy.findVisibleTargetWithUsage(targetId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
    // Le codec du **domicile** de la cible : une projetée reste chiffrée sous
    // la clé de son espace d'origine, et la relire avec celle d'ici rendrait un
    // nom vide qu'on croirait mal enregistré.
    const shares = await shareScope(ctx, 'deploy');
    return toTarget(await shares.cipherFor(row.id), row, row.workspace_id !== ctx.workspaceId);
}

/** Un état venu de la base : inconnu vaut `null`, jamais une valeur inventée. */
function normalizeStatus(raw: string | null): Deployment['status'] | null {
    if (raw === 'success' || raw === 'failed' || raw === 'running' || raw === 'queued') return raw;
    return null;
}

export async function toDeployment(cipher: Cipher, row: DeploymentRow): Promise<Deployment> {
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
 * Charge une clé Dokploy utilisable, ou explique ce qui manque.
 *
 * L'adresse de l'instance vit sur le jeton et non sur la cible : deux cibles de
 * la même instance ne peuvent donc pas en donner deux versions différentes, et
 * déménager une instance se règle en un seul endroit.
 */
export async function loadDokployCredential(
    ctx: FeatureContext,
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
    const credential = await ctx.db.credentials.find(credentialId, home, 'dokploy');
    if (!credential) throw new FeatureError('not_found', 'Accès Dokploy introuvable');
    if (!credential.base_url) {
        throw new FeatureError('validation', 'Cet accès Dokploy n’a pas d’adresse d’instance.');
    }
    // Le codec du **domicile**, étage ouvert toujours : le suivi tourne sans
    // session, et le secret d'une cible projetée est scellé sous la clé de son
    // espace. `cipherFor(target.id)` ne rend un codec étranger que si la
    // projection existe réellement — la garde de `_sharing.ts`.
    const cipher =
        target && target.workspace_id !== ctx.workspaceId
            ? await (await shareScope(ctx, 'deploy')).cipherFor(target.id)
            : ctx.secure.open;
    return { baseUrl: credential.base_url, apiKey: await cipher.decrypt(credential.secret_enc) };
}

export const READ = { feature: 'deploy' } as const;
export const WRITE = { feature: 'deploy', level: 'write' } as const;
