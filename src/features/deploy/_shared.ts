import type { DeployTarget, DeployTargetRow, Deployment, DeploymentRow } from 'deveye-types';
import { deployTargetSchema } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import type { DeployTargetWithUsageRow } from 'deveye-types';
import { FeatureError, type FeatureContext } from '../_define';

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
     * L'identifiant du message Discord qui suit ce déploiement en direct.
     *
     * Dans le blob et non dans une colonne : il n'est jamais un critère de
     * recherche, seulement une donnée qu'on transporte avec la ligne — et le
     * blob est déjà réécrit à chaque changement d'état. Une colonne aurait coûté
     * une migration pour un champ que rien n'interroge.
     *
     * **Persisté, et c'est le point** : un serveur redémarré au milieu d'un
     * déploiement retrouve le message qu'il avait ouvert et continue de le
     * modifier, au lieu d'en poser un second à côté du premier.
     */
    noticeId?: string | null;
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
 * Charge une cible de l'espace actif, ou lève `not_found`.
 *
 * C'est **la** frontière d'espace de la feature : toute commande qui prend un
 * `targetId` commence par là, sans quoi elle répondrait sur la cible d'autrui.
 */
export async function loadTarget(ctx: FeatureContext, targetId: number): Promise<DeployTargetRow> {
    const row = await ctx.db.deploy.findTarget(targetId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
    return row;
}

export async function toTarget(cipher: Cipher, row: DeployTargetWithUsageRow): Promise<DeployTarget> {
    const body = await readJson<Partial<StoredTarget>>(cipher, row.content);
    return deployTargetSchema.parse({
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
    const row = await ctx.db.deploy.findTargetWithUsage(targetId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Cible de déploiement introuvable');
    return toTarget(deployCipher(ctx), row);
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
    credentialId: number
): Promise<{ baseUrl: string; apiKey: string }> {
    const credential = await ctx.db.credentials.find(credentialId, ctx.workspaceId, 'dokploy');
    if (!credential) throw new FeatureError('not_found', 'Accès Dokploy introuvable');
    if (!credential.base_url) {
        throw new FeatureError('validation', 'Cet accès Dokploy n’a pas d’adresse d’instance.');
    }
    // Étage ouvert, toujours : le suivi des déploiements tourne sans session.
    return { baseUrl: credential.base_url, apiKey: await ctx.secure.open.decrypt(credential.secret_enc) };
}

export const READ = { feature: 'deploy' } as const;
export const WRITE = { feature: 'deploy', level: 'write' } as const;
