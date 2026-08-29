import { gitCredentialAdd, gitCredentialList, gitCredentialRemove, gitCredentialUpdate } from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { toCredential, type Ctx } from './_shared';

/**
 * Les jetons GitHub de l'espace, et non d'un projet : un même jeton ouvre en
 * général plusieurs dépôts, le ressaisir par projet serait pénible et plus risqué.
 *
 * Les secrets ne sortent jamais, le DTO ne porte qu'un `hasSecret`. Ils sont
 * toujours chiffrés à l'étage ouvert, quel que soit le palier des projets qui
 * s'en servent : le service de fond doit les lire sans session.
 */

export const gitCredentialFeatures = [
    defineSdkFeature({
        ...gitCredentialList,
        handler: async (ctx: Ctx) => {
            const [rows, uses] = await Promise.all([
                ctx.repo.listCredentials(ctx.workspaceId),
                ctx.repo.countCredentialUses(ctx.workspaceId)
            ]);
            return { credentials: rows.map((row) => toCredential(row, uses.get(row.id) ?? 0)) };
        }
    }),
    defineSdkFeature({
        ...gitCredentialAdd,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.createCredential({
                workspaceId: ctx.workspaceId,
                label: input.label,
                secretEnc: await ctx.cipher().encrypt(input.secret)
            });
            ctx.audit({
                action: 'git.credentialAdd',
                description: 'Jeton GitHub ajouté',
                metadata: { credentialId: row.id }
            });
            // Neuf, donc encore utilisé par rien.
            return { credential: toCredential(row, 0) };
        }
    }),
    defineSdkFeature({
        ...gitCredentialUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await ctx.repo.updateCredential(input.credentialId, ctx.workspaceId, {
                label: input.label,
                // Secret absent = inchangé. Le client ne l'a jamais reçu, il ne peut
                // donc pas le renvoyer à l'identique.
                secretEnc: input.secret ? await ctx.cipher().encrypt(input.secret) : undefined
            });
            if (!row) throw new FeatureError('not_found', 'Jeton introuvable');
            const uses = await ctx.repo.countCredentialUses(ctx.workspaceId);
            return { credential: toCredential(row, uses.get(row.id) ?? 0) };
        }
    }),
    defineSdkFeature({
        ...gitCredentialRemove,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            // Ce qui s'en servait garde son lien mais perd son accès : le dépôt met
            // les dépôts du jeton à NULL avant de retirer la ligne, faute de clé
            // étrangère, et la synchronisation s'arrête en le disant.
            const ok = await ctx.repo.removeCredential(input.credentialId, ctx.workspaceId);
            if (!ok) throw new FeatureError('not_found', 'Jeton introuvable');
            ctx.audit({
                action: 'git.credentialRemove',
                description: 'Jeton GitHub retiré',
                metadata: { credentialId: input.credentialId }
            });
            return { credentialId: input.credentialId };
        }
    })
];
