import { gitCredentialAdd, gitCredentialList, gitCredentialRemove, gitCredentialUpdate } from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { toCredential, type Ctx } from './_shared';

/**
 * Les jetons **GitHub** de l'espace.
 *
 * Ils vivent ici et non dans un projet : un même jeton ouvre en général
 * plusieurs dépôts, et le ressaisir par projet serait à la fois pénible et plus
 * risqué.
 *
 * Les clés **Dokploy** ont quitté cet écran : elles appartiennent à la feature
 * Déploiement (`features/deploy/src/server/handlers.ts`). Elles n'avaient
 * atterri ici que parce que ce module fut le premier à savoir gérer un secret,
 * à une époque où le déploiement n'était qu'un onglet de projet sans place pour
 * le sien.
 *
 * Le comportement était dans `_credentials.ts`, partagé avec l'autre porte sur
 * une table à deux propriétaires. Le rapatriement en module a donné aux jetons
 * leur table (`ft_git_credentials`, migration 100 du socle) et leurs quatre
 * gestes ICI, sur le dépôt du module. Aucun `baseUrl` : l'API GitHub est
 * publique, il n'y a pas d'instance à désigner.
 *
 * ⚠️ Les secrets ne sortent **jamais** : le DTO ne porte qu'un `hasSecret`.
 * Toujours chiffrés à l'étage **ouvert**, quel que soit le palier des projets
 * qui s'en servent : le service de fond doit les lire sans session.
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
            // Ce qui s'en servait garde son lien mais perd son accès (le dépôt
            // met les dépôts du jeton à NULL avant de retirer la ligne : le
            // ménage explicite qui remplace la clé étrangère retirée par la
            // 100) : la synchronisation s'arrête proprement et le dit, au lieu
            // de disparaître avec le jeton.
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
