import { userDeleteAccount } from '@deveye/types';

import { verifyPassword } from '@/auth/argon';
import { assertAttemptAllowed, LockedOutError, recordFailedAttempt } from '@/Services/attempts';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { notifyModulesAccountDeleted } from '../_sdk/register';
import { deleteUserEverywhere } from '../_users';

/**
 * Le titulaire supprime son compte. Le mot de passe est redemandé, avec le
 * même compteur d'essais que son changement : une session volée ne suffit
 * pas à tout effacer.
 */
export const userDeleteAccountFeature: FeatureDefinition<
    typeof userDeleteAccount.command,
    typeof userDeleteAccount.input,
    typeof userDeleteAccount.output
> = defineFeature({
    ...userDeleteAccount,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const row = await ctx.db.users.findById(ctx.userId);
        if (!row) throw new FeatureError('not_found', 'Compte introuvable');

        const attemptKey = String(ctx.userId);
        try {
            assertAttemptAllowed('password', attemptKey);
        } catch (e) {
            if (e instanceof LockedOutError) throw new FeatureError('rate_limited', e.message);
            throw e;
        }
        if (!(await verifyPassword(row.password_hash, input.password))) {
            recordFailedAttempt('password', attemptKey);
            ctx.audit({
                action: 'user.deleteSelf_failed',
                level: 'warning',
                category: 'user',
                description: 'Suppression du compte refusée : mot de passe incorrect'
            });
            throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
        }
        if (row.role === 'admin' && (await ctx.db.users.listAdminIds()).length <= 1) {
            throw new FeatureError('forbidden', 'Le dernier administrateur du site ne peut pas supprimer son compte');
        }

        // Les modules d'abord : un abonnement ne survit pas au compte.
        await notifyModulesAccountDeleted(ctx.userId);
        // La socket qui porte cette commande est celle du compte : fermée dans
        // le handler, elle emporterait la réponse. Un tour de boucle plus tard,
        // la réponse est partie ; les sessions, elles, sont déjà oubliées.
        const live = ctx.live;
        await deleteUserEverywhere(
            {
                db: ctx.db,
                live: live && {
                    evictEverywhere: (userId) => live.evictEverywhere(userId),
                    evictRoom: (workspaceId) => live.evictRoom(workspaceId),
                    userChanged: (...args) => live.userChanged(...args),
                    closeSessionsOf: (userId) => setImmediate(() => live.closeSessionsOf(userId))
                }
            },
            ctx.userId,
            { userId: ctx.userId, workspaceId: ctx.workspaceId }
        );

        ctx.audit({
            action: 'user.deleteSelf',
            level: 'critical',
            category: 'user',
            description: `Compte supprimé par son titulaire : « ${row.username} », avec tous ses espaces`
        });
        return { ok: true };
    }
});
