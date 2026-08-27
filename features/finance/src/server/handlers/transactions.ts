import {
    financeTransactionAdd,
    financeTransactionList,
    financeTransactionRemove,
    financeTransactionSetCleared,
    financeTransactionUpdate
} from '../../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import type { FinanceTransactionFilter } from '../repo';
import {
    assertEntryConsistent,
    decryptAll,
    encryptJson,
    financeCipher,
    postDueRecurring,
    toTransaction,
    WRITE,
    type Ctx,
    type StoredEntry
} from '../_shared';

/**
 * Le journal: les opérations elles-mêmes.
 *
 * Trois natures, une seule table. Un **virement** y est une ligne unique qui
 * porte ses deux comptes, et non une paire de lignes: une paire devrait rester
 * cohérente à chaque modification, et une paire à moitié supprimée ferait
 * apparaître de l'argent.
 */

/** Combien de lignes une page rend par défaut. */
const DEFAULT_LIMIT = 100;

function filterOf(input: {
    accountId?: number;
    categoryId?: number;
    kind?: 'expense' | 'income' | 'transfer';
    from?: string;
    to?: string;
    cleared?: boolean;
}): FinanceTransactionFilter {
    return {
        accountId: input.accountId,
        categoryId: input.categoryId,
        kind: input.kind,
        from: input.from,
        to: input.to,
        cleared: input.cleared
    };
}

export const financeTransactionListFeature = defineSdkFeature({
    ...financeTransactionList,
    handler: async (ctx: Ctx, input) => {
        await postDueRecurring(ctx);
        const filter = filterOf(input);
        const [rows, total, totals] = await Promise.all([
            ctx.repo.listTransactions(ctx.workspaceId, filter, input.limit ?? DEFAULT_LIMIT, input.offset ?? 0),
            ctx.repo.countTransactions(ctx.workspaceId, filter),
            // Les sommes portent sur **tout** le filtre et non sur la page: un
            // total qui ne compterait que les cent lignes affichées sur trois
            // cents induirait en erreur précisément là où on vient chercher un
            // chiffre juste.
            ctx.repo.sumTransactions(ctx.workspaceId, filter)
        ]);
        return {
            transactions: await decryptAll(financeCipher(ctx), rows, toTransaction),
            total,
            totals: { ...totals, net: totals.income - totals.expense }
        };
    }
});

export const financeTransactionAddFeature = defineSdkFeature({
    ...financeTransactionAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const draft = input.transaction;
        await assertEntryConsistent(ctx, draft);
        const payload: StoredEntry = {
            label: draft.label.trim(),
            counterparty: draft.counterparty.trim(),
            note: draft.note
        };
        const id = await ctx.repo.createTransaction(ctx.workspaceId, {
            accountId: draft.accountId,
            transferAccountId: draft.transferAccountId,
            categoryId: draft.categoryId,
            // Une saisie à la main n'est jamais rattachée à une échéance: seul
            // le rattrapage pose ce lien, et c'est lui qui rend l'index unique
            // `(recurring_id, date)` utile sans gêner personne.
            recurringId: null,
            kind: draft.kind,
            amount: draft.amount,
            vatAmount: draft.vatAmount,
            date: draft.date,
            cleared: draft.cleared,
            content: await encryptJson(financeCipher(ctx), payload)
        });
        const row = await ctx.repo.findTransaction(id, ctx.workspaceId);
        if (!row) throw new FeatureError('internal', 'Opération introuvable après création');
        ctx.audit({
            action: 'finance.transactionAdd',
            description: 'Opération enregistrée',
            metadata: { transactionId: id, kind: draft.kind, amount: draft.amount }
        });
        return { transaction: toTransaction(row, payload) };
    }
});

export const financeTransactionUpdateFeature = defineSdkFeature({
    ...financeTransactionUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await ctx.repo.findTransaction(input.transactionId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Opération introuvable');
        const draft = input.transaction;
        await assertEntryConsistent(ctx, draft);

        // Une opération née d'une échéance garde son rattachement, et l'index
        // unique `(recurring_id, date)` interdit alors de la dater sur une autre
        // occurrence de la même échéance. Le dire clairement vaut mieux qu'une
        // erreur de contrainte remontée telle quelle.
        if (existing.recurring_id !== null && existing.date !== draft.date) {
            const clash = await ctx.repo.findOccurrence(ctx.workspaceId, existing.recurring_id, draft.date);
            if (clash) {
                throw new FeatureError(
                    'conflict',
                    'Cette échéance a déjà une occurrence à cette date. Choisissez une autre date.'
                );
            }
        }

        const payload: StoredEntry = {
            label: draft.label.trim(),
            counterparty: draft.counterparty.trim(),
            note: draft.note
        };
        const updated = await ctx.repo.updateTransaction(input.transactionId, ctx.workspaceId, {
            accountId: draft.accountId,
            transferAccountId: draft.transferAccountId,
            categoryId: draft.categoryId,
            recurringId: existing.recurring_id,
            kind: draft.kind,
            amount: draft.amount,
            vatAmount: draft.vatAmount,
            date: draft.date,
            cleared: draft.cleared,
            content: await encryptJson(financeCipher(ctx), payload)
        });
        if (!updated) throw new FeatureError('not_found', 'Opération introuvable');
        const row = await ctx.repo.findTransaction(input.transactionId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Opération introuvable');
        ctx.audit({
            action: 'finance.transactionUpdate',
            description: 'Opération modifiée',
            metadata: { transactionId: input.transactionId }
        });
        return { transaction: toTransaction(row, payload) };
    }
});

export const financeTransactionRemoveFeature = defineSdkFeature({
    ...financeTransactionRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await ctx.repo.findTransaction(input.transactionId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Opération introuvable');
        await ctx.repo.deleteTransaction(input.transactionId, ctx.workspaceId);
        ctx.audit({
            action: 'finance.transactionRemove',
            level: 'warning',
            description: 'Opération supprimée',
            metadata: {
                transactionId: input.transactionId,
                kind: existing.kind,
                amount: Number(existing.amount),
                date: existing.date
            }
        });
        return { transactionId: input.transactionId };
    }
});

export const financeTransactionSetClearedFeature = defineSdkFeature({
    ...financeTransactionSetCleared,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        // La requête filtre déjà sur l'espace: un identifiant étranger ne
        // touche rien, et il n'y a donc rien à vérifier ligne par ligne. Pas
        // d'audit non plus: pointer n'ajoute, ne retire ni ne modifie aucun
        // montant, et le rapprochement d'un relevé en produit des dizaines à la
        // minute, ce qui noierait le journal d'audit sans rien apprendre.
        await ctx.repo.setCleared(ctx.workspaceId, input.transactionIds, input.cleared);
        return { transactionIds: input.transactionIds, cleared: input.cleared };
    }
});
