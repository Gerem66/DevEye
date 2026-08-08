import { gitCredentialAdd, gitCredentialList, gitCredentialRemove, gitCredentialUpdate } from 'deveye-types';
import type { GitCredential, GitCredentialRow } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { gitCipher, READ, WRITE } from './_shared';

/**
 * Les jetons d'accès de l'espace — GitHub et Dokploy.
 *
 * Ils vivent ici et non dans un projet : un jeton GitHub sert en général à
 * plusieurs dépôts, une clé Dokploy ne relève d'aucun dépôt, et le ressaisir par
 * projet serait à la fois pénible et plus risqué.
 *
 * ⚠️ Les secrets ne sortent **jamais** : les DTO ne portent qu'un `hasSecret`.
 * Un secret qu'on ne renvoie pas est un secret qui ne peut fuiter ni par une
 * capture d'écran ni par un journal.
 *
 * Toujours sous l'étage ouvert, quel que soit le palier des projets qui s'en
 * servent : le service de fond doit les lire sans session (voir `gitCipher`).
 */

function toCredential(row: GitCredentialRow, useCount: number): GitCredential {
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

export const gitCredentialListFeature: FeatureDefinition<
    typeof gitCredentialList.command,
    typeof gitCredentialList.input,
    typeof gitCredentialList.output
> = defineFeature({
    ...gitCredentialList,
    access: READ,
    handler: async (ctx) => {
        const [rows, uses] = await Promise.all([
            ctx.db.git.listCredentials(ctx.workspaceId),
            ctx.db.git.countCredentialUses(ctx.workspaceId)
        ]);
        return { credentials: rows.map((row) => toCredential(row, uses.get(row.id) ?? 0)) };
    }
});

export const gitCredentialAddFeature: FeatureDefinition<
    typeof gitCredentialAdd.command,
    typeof gitCredentialAdd.input,
    typeof gitCredentialAdd.output
> = defineFeature({
    ...gitCredentialAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await ctx.db.git.createCredential({
            workspaceId: ctx.workspaceId,
            provider: input.provider,
            label: input.label,
            baseUrl: input.baseUrl,
            secretEnc: await gitCipher(ctx).encrypt(input.secret)
        });
        ctx.audit({
            action: 'git.credentialAdd',
            description: `Jeton ${input.provider} ajouté`,
            metadata: { credentialId: row.id, provider: input.provider }
        });
        // Neuf, donc encore utilisé par rien.
        return { credential: toCredential(row, 0) };
    }
});

export const gitCredentialUpdateFeature: FeatureDefinition<
    typeof gitCredentialUpdate.command,
    typeof gitCredentialUpdate.input,
    typeof gitCredentialUpdate.output
> = defineFeature({
    ...gitCredentialUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await ctx.db.git.updateCredential(input.credentialId, ctx.workspaceId, {
            label: input.label,
            baseUrl: input.baseUrl,
            // Secret absent = inchangé. Le client ne l'a jamais reçu, il ne peut
            // donc pas le renvoyer à l'identique.
            secretEnc: input.secret ? await gitCipher(ctx).encrypt(input.secret) : undefined
        });
        if (!row) throw new FeatureError('not_found', 'Jeton introuvable');
        const uses = await ctx.db.git.countCredentialUses(ctx.workspaceId);
        return { credential: toCredential(row, uses.get(row.id) ?? 0) };
    }
});

export const gitCredentialRemoveFeature: FeatureDefinition<
    typeof gitCredentialRemove.command,
    typeof gitCredentialRemove.input,
    typeof gitCredentialRemove.output
> = defineFeature({
    ...gitCredentialRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Les dépôts et les cibles de déploiement qui s'en servaient gardent leur
        // lien mais perdent leur accès (`ON DELETE SET NULL`) : la
        // synchronisation s'arrête proprement et le dit, au lieu de disparaître
        // avec le jeton.
        const ok = await ctx.db.git.deleteCredential(input.credentialId, ctx.workspaceId);
        if (!ok) throw new FeatureError('not_found', 'Jeton introuvable');
        ctx.audit({
            action: 'git.credentialRemove',
            description: 'Jeton retiré',
            metadata: { credentialId: input.credentialId }
        });
        return { credentialId: input.credentialId };
    }
});

export const gitCredentialFeatures = [
    gitCredentialListFeature,
    gitCredentialAddFeature,
    gitCredentialUpdateFeature,
    gitCredentialRemoveFeature
];
