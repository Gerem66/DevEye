import type { Credential, CredentialProvider, CredentialRow } from '@deveye/types';
import { FeatureError, type FeatureContext } from './_define';

/**
 * Les quatre gestes d'un jeton d'accès, écrits une fois pour les deux features
 * qui en possèdent.
 *
 * **Une table, deux portes.** Git détient les jetons GitHub, Déploiement les
 * clés Dokploy : ce sont deux droits distincts (lire des dépôts n'autorise pas à
 * poser la clé qui met en production), mais un seul comportement. Ce module
 * porte le comportement ; chaque feature déclare ses commandes et son `access`,
 * et passe son fournisseur — que le dépôt exige sur **chaque** lecture, de sorte
 * qu'aucune ne peut servir par mégarde le jeton de l'autre.
 *
 * ⚠️ Les secrets ne sortent **jamais** : le DTO ne porte qu'un `hasSecret`. Un
 * secret qu'on ne renvoie pas est un secret qui ne peut fuiter ni par une
 * capture d'écran ni par un journal.
 *
 * Toujours chiffrés à l'étage **ouvert**, quel que soit le palier des projets
 * qui s'en servent : les deux services de fond doivent les lire sans session.
 */

function toCredential(row: CredentialRow, useCount: number): Credential {
    return {
        id: row.id,
        provider: row.provider === 'dokploy' ? 'dokploy' : 'github',
        label: row.label,
        baseUrl: row.base_url,
        hasSecret: row.secret_enc.length > 0,
        created: row.created,
        useCount
    };
}

export async function listCredentials(ctx: FeatureContext, provider: CredentialProvider): Promise<Credential[]> {
    const [rows, uses] = await Promise.all([
        ctx.db.credentials.listByProvider(ctx.workspaceId, provider),
        ctx.db.credentials.countUses(ctx.workspaceId, provider)
    ]);
    return rows.map((row) => toCredential(row, uses.get(row.id) ?? 0));
}

export async function addCredential(
    ctx: FeatureContext,
    provider: CredentialProvider,
    input: { label: string; baseUrl: string | null; secret: string }
): Promise<Credential> {
    const row = await ctx.db.credentials.create({
        workspaceId: ctx.workspaceId,
        provider,
        label: input.label,
        baseUrl: input.baseUrl,
        secretEnc: await ctx.secure.open.encrypt(input.secret)
    });
    ctx.audit({
        action: `${provider === 'dokploy' ? 'deploy' : 'git'}.credentialAdd`,
        description: `Jeton ${provider} ajouté`,
        metadata: { credentialId: row.id, provider }
    });
    // Neuf, donc encore utilisé par rien.
    return toCredential(row, 0);
}

export async function updateCredential(
    ctx: FeatureContext,
    provider: CredentialProvider,
    input: { credentialId: number; label: string; baseUrl: string | null; secret?: string }
): Promise<Credential> {
    const row = await ctx.db.credentials.update(input.credentialId, ctx.workspaceId, provider, {
        label: input.label,
        baseUrl: input.baseUrl,
        // Secret absent = inchangé. Le client ne l'a jamais reçu, il ne peut
        // donc pas le renvoyer à l'identique.
        secretEnc: input.secret ? await ctx.secure.open.encrypt(input.secret) : undefined
    });
    if (!row) throw new FeatureError('not_found', 'Jeton introuvable');
    const uses = await ctx.db.credentials.countUses(ctx.workspaceId, provider);
    return toCredential(row, uses.get(row.id) ?? 0);
}

export async function removeCredential(
    ctx: FeatureContext,
    provider: CredentialProvider,
    credentialId: number
): Promise<void> {
    // Ce qui s'en servait garde son lien mais perd son accès
    // (`ON DELETE SET NULL`) : la synchronisation — ou le déploiement — s'arrête
    // proprement et le dit, au lieu de disparaître avec le jeton.
    const ok = await ctx.db.credentials.remove(credentialId, ctx.workspaceId, provider);
    if (!ok) throw new FeatureError('not_found', 'Jeton introuvable');
    ctx.audit({
        action: `${provider === 'dokploy' ? 'deploy' : 'git'}.credentialRemove`,
        description: `Jeton ${provider} retiré`,
        metadata: { credentialId, provider }
    });
}
