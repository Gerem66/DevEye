import {
    financeAccountAdd,
    financeAccountList,
    financeAccountRemove,
    financeAccountReorder,
    financeAccountUpdate
} from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import {
    decryptAll,
    encryptJson,
    financeCipher,
    postDueRecurring,
    READ,
    toAccount,
    today,
    WRITE,
    type StoredAccount
} from './_shared';

/**
 * Les comptes de l'espace.
 *
 * Un compte est le seul objet de la feature qui porte un **solde de départ**:
 * c'est le point où le livre commence, et il vaut à toutes les dates. Tout le
 * reste des soldes se déduit des opérations, jamais d'un compteur entretenu à la
 * main, pour qu'une correction d'une opération d'il y a six mois se répercute
 * d'elle-même sur le solde d'aujourd'hui.
 */

export const financeAccountListFeature: FeatureDefinition<
    typeof financeAccountList.command,
    typeof financeAccountList.input,
    typeof financeAccountList.output
> = defineFeature({
    ...financeAccountList,
    access: READ,
    handler: async (ctx, input) => {
        await postDueRecurring(ctx);
        const rows = await ctx.db.finance.listAccounts(ctx.workspaceId, input.archived === true, today());
        return { accounts: await decryptAll(financeCipher(ctx), rows, toAccount) };
    }
});

export const financeAccountAddFeature: FeatureDefinition<
    typeof financeAccountAdd.command,
    typeof financeAccountAdd.input,
    typeof financeAccountAdd.output
> = defineFeature({
    ...financeAccountAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const cipher = financeCipher(ctx);
        const payload: StoredAccount = { name: input.account.name.trim(), note: input.account.note };
        const id = await ctx.db.finance.createAccount(ctx.workspaceId, {
            kind: input.account.kind,
            color: input.account.color,
            initialBalance: input.account.initialBalance,
            archived: input.account.archived,
            content: await encryptJson(cipher, payload)
        });
        const row = await ctx.db.finance.findAccount(id, ctx.workspaceId, today());
        if (!row) throw new FeatureError('internal', 'Compte introuvable après création');
        ctx.audit({ action: 'finance.accountAdd', description: 'Compte créé', metadata: { accountId: id } });
        return { account: toAccount(row, payload) };
    }
});

export const financeAccountUpdateFeature: FeatureDefinition<
    typeof financeAccountUpdate.command,
    typeof financeAccountUpdate.input,
    typeof financeAccountUpdate.output
> = defineFeature({
    ...financeAccountUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const cipher = financeCipher(ctx);
        const payload: StoredAccount = { name: input.account.name.trim(), note: input.account.note };
        const updated = await ctx.db.finance.updateAccount(input.accountId, ctx.workspaceId, {
            kind: input.account.kind,
            color: input.account.color,
            initialBalance: input.account.initialBalance,
            archived: input.account.archived,
            content: await encryptJson(cipher, payload)
        });
        if (!updated) throw new FeatureError('not_found', 'Compte introuvable');
        const row = await ctx.db.finance.findAccount(input.accountId, ctx.workspaceId, today());
        if (!row) throw new FeatureError('not_found', 'Compte introuvable');
        ctx.audit({
            action: 'finance.accountUpdate',
            description: 'Compte modifié',
            metadata: { accountId: input.accountId }
        });
        return { account: toAccount(row, payload) };
    }
});

export const financeAccountRemoveFeature: FeatureDefinition<
    typeof financeAccountRemove.command,
    typeof financeAccountRemove.input,
    typeof financeAccountRemove.output
> = defineFeature({
    ...financeAccountRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await ctx.db.finance.findAccount(input.accountId, ctx.workspaceId, today());
        if (!row) throw new FeatureError('not_found', 'Compte introuvable');

        // Le garde-fou du livre. Les deux clés étrangères sont en CASCADE, donc
        // supprimer le compte emporterait sans un mot ses opérations **et** les
        // échéances réglées dessus: de l'argent disparaîtrait d'un livre de
        // comptes, ce qui est exactement ce qu'un livre de comptes ne doit
        // jamais faire. Le geste réversible existe déjà, c'est l'archivage.
        const [used, scheduled] = await Promise.all([
            ctx.db.finance.countAccountUsage(input.accountId, ctx.workspaceId),
            ctx.db.finance.countAccountRecurring(input.accountId, ctx.workspaceId)
        ]);
        if (used > 0) {
            throw new FeatureError(
                'conflict',
                `Ce compte porte ${used} opération${used > 1 ? 's' : ''}. Archivez-le plutôt que de le supprimer, ` +
                    'ou déplacez ses opérations avant.'
            );
        }
        if (scheduled > 0) {
            throw new FeatureError(
                'conflict',
                `Ce compte porte ${scheduled} échéance${scheduled > 1 ? 's' : ''}. ` +
                    'Supprimez-les ou déplacez-les avant, ou archivez le compte.'
            );
        }

        await ctx.db.finance.deleteAccount(input.accountId, ctx.workspaceId);
        ctx.audit({
            action: 'finance.accountRemove',
            level: 'warning',
            description: 'Compte supprimé',
            metadata: { accountId: input.accountId }
        });
        return { accountId: input.accountId };
    }
});

export const financeAccountReorderFeature: FeatureDefinition<
    typeof financeAccountReorder.command,
    typeof financeAccountReorder.input,
    typeof financeAccountReorder.output
> = defineFeature({
    ...financeAccountReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        // Seuls les comptes de cet espace sont replacés; un identifiant étranger
        // est ignoré en silence, comme sur les autres listes ordonnables.
        const owned = new Set((await ctx.db.finance.listAccounts(ctx.workspaceId, true, today())).map((row) => row.id));
        const accountIds = input.accountIds.filter((id) => owned.has(id));
        await ctx.db.finance.reorderAccounts(ctx.workspaceId, accountIds);
        return { accountIds };
    }
});
