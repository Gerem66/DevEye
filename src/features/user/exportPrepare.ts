import { userExportPrepare } from '@deveye/types';

import { verifyPassword } from '@/auth/argon';
import { issueExportTicket } from '@/Services/accountExport/tickets';
import { assertAttemptAllowed, LockedOutError, recordFailedAttempt } from '@/Services/attempts';
import { maintenance } from '@/Services/maintenance';
import { discardExportDek, lendExportDek } from '@/Services/SecureStore';
import { SecretKeyService } from '@/Services/SecretKeyService';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { haltedExportModules, optionalExportKeys } from '../_sdk/register';

/**
 * Le titulaire demande l'export de ses données. Le mot de passe est redemandé,
 * avec le compteur d'essais de la suppression : l'archive porte ce qu'il
 * protège, en clair. La clé du compte est prêtée à ce seul export, sous un
 * lien qui ne sert qu'une fois.
 */
export const userExportPrepareFeature: FeatureDefinition<
    typeof userExportPrepare.command,
    typeof userExportPrepare.input,
    typeof userExportPrepare.output
> = defineFeature({
    ...userExportPrepare,
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
                action: 'user.export_failed',
                level: 'warning',
                category: 'user',
                description: 'Export des données refusé : mot de passe incorrect'
            });
            throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
        }

        const optional = optionalExportKeys();
        const unknown = input.leaveOut.filter((key) => !optional.has(key));
        if (unknown.length > 0) throw new FeatureError('validation', `Partie inconnue : ${unknown.join(', ')}`);
        const halted = haltedExportModules((id) => maintenance.featureLevel(id) === 'full');
        if (halted.length > 0) {
            throw new FeatureError('conflict', `En maintenance, à exporter plus tard : ${halted.join(', ')}`);
        }

        // Toujours déballée ici, par le mot de passe s'il la protège : un
        // changement de mode entre la demande et le téléchargement n'y change rien.
        const keys = new SecretKeyService(ctx.db, ctx.crypt);
        const keyRow = await keys.ensureRow(ctx.userId);
        const dek = keys.isPasswordWrapped(keyRow)
            ? await keys.unwrapWithPassword(keyRow, input.password).catch(() => {
                  throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
              })
            : keys.resolveServerDek(keyRow);
        const dekToken = lendExportDek(ctx.userId, dek);
        dek.fill(0);

        const ticket = issueExportTicket(
            { userId: ctx.userId, sessionId: ctx.sessionId, leaveOut: input.leaveOut, dekToken },
            (dropped) => discardExportDek(dropped.dekToken)
        );
        ctx.audit({
            action: 'user.exportPrepare',
            level: 'warning',
            category: 'user',
            description: 'Export des données demandé : l’archive porte des secrets en clair',
            metadata: { leaveOut: input.leaveOut }
        });
        return { url: `/api/account/export?token=${ticket.token}`, expiresAt: ticket.expiresAt };
    }
});
