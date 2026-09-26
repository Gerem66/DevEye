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
    decryptJson,
    encryptJson,
    financeCipher,
    toTransaction,
    WRITE,
    type Ctx,
    type StoredEntry
} from '../_shared';
import { catchUp } from '../sources';

/** Ce que dit un refus sur une copie de règlement. */
const SOURCED_REFUSAL = 'Ce règlement vient de Facturation : son montant, sa date et son intitulé se corrigent là-bas.';

/**
 * Le journal. Un virement est une ligne unique portant ses deux comptes : une
 * paire à moitié supprimée ferait apparaître de l'argent.
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
        await catchUp(ctx);
        const filter = filterOf(input);
        const [rows, total, totals] = await Promise.all([
            ctx.repo.listTransactions(ctx.workspaceId, filter, input.limit ?? DEFAULT_LIMIT, input.offset ?? 0),
            ctx.repo.countTransactions(ctx.workspaceId, filter),
            // Les sommes portent sur tout le filtre, pas sur la page.
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
            // Seul le rattrapage rattache une opération à une échéance.
            recurringId: null,
            source: null,
            sourceRef: null,
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

        // L'index unique `(recurring_id, date)` interdit de la dater sur une autre
        // occurrence de la même échéance : le dire plutôt qu'une erreur de contrainte.
        if (existing.recurring_id !== null && existing.date !== draft.date) {
            const clash = await ctx.repo.findOccurrence(ctx.workspaceId, existing.recurring_id, draft.date);
            if (clash) {
                throw new FeatureError(
                    'conflict',
                    'Cette échéance a déjà une occurrence à cette date. Choisissez une autre date.'
                );
            }
        }

        const cipher = financeCipher(ctx);
        let origin: StoredEntry['origin'];
        if (existing.source !== null) {
            // Une copie de règlement : ses faits appartiennent à Facturation.
            // Le compte, la catégorie, le pointage et la note restent au livre.
            const stored = await decryptJson<StoredEntry>(cipher, existing.content);
            const factsKept =
                draft.kind === existing.kind &&
                draft.amount === Number(existing.amount) &&
                draft.date === existing.date &&
                draft.vatAmount === (existing.vat_amount === null ? null : Number(existing.vat_amount)) &&
                draft.label.trim() === (stored?.label ?? '') &&
                draft.counterparty.trim() === (stored?.counterparty ?? '');
            if (!factsKept) throw new FeatureError('conflict', SOURCED_REFUSAL);
            origin = stored?.origin;
        }

        const payload: StoredEntry = {
            label: draft.label.trim(),
            counterparty: draft.counterparty.trim(),
            note: draft.note,
            ...(origin ? { origin } : {})
        };
        const updated = await ctx.repo.updateTransaction(input.transactionId, ctx.workspaceId, {
            accountId: draft.accountId,
            transferAccountId: draft.transferAccountId,
            categoryId: draft.categoryId,
            recurringId: existing.recurring_id,
            source: existing.source,
            sourceRef: existing.source_ref,
            kind: draft.kind,
            amount: draft.amount,
            vatAmount: draft.vatAmount,
            date: draft.date,
            cleared: draft.cleared,
            content: await encryptJson(cipher, payload)
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
        if (existing.source !== null) {
            throw new FeatureError(
                'conflict',
                'Ce règlement vient de Facturation : c’est là-bas qu’il se retire, et sa copie part avec lui.'
            );
        }
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
        // La requête filtre déjà sur l'espace. Pas d'audit : pointer ne modifie
        // aucun montant, et un rapprochement en produit des dizaines à la minute.
        await ctx.repo.setCleared(ctx.workspaceId, input.transactionIds, input.cleared);
        return { transactionIds: input.transactionIds, cleared: input.cleared };
    }
});
