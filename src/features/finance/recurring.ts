import {
    financeRecurringAdd,
    financeRecurringList,
    financeRecurringPost,
    financeRecurringRemove,
    financeRecurringSkip,
    financeRecurringUpdate
} from '@deveye/types';
import type { FinanceRecurringRow } from '@deveye/types';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import {
    anchorDayOf,
    assertEntryConsistent,
    decryptAll,
    decryptJson,
    encryptJson,
    financeCipher,
    nextOccurrence,
    postDueRecurring,
    READ,
    toRecurring,
    toTransaction,
    WRITE,
    type StoredEntry
} from './_shared';

/**
 * Les échéances: les opérations qui reviennent.
 *
 * Elles n'ont **aucune tâche de fond** derrière elles. Ce qui les fait exister
 * est `postDueRecurring`, appelé en tête de chaque lecture de la feature: la
 * première lecture qui suit la date écrit ce qui manque. Les raisons de ce choix
 * sont dans `_shared.ts`, à côté du code qui l'applique.
 *
 * Ce fichier ne porte donc que les gestes explicites: régler une échéance,
 * l'écrire tout de suite, ou passer une occurrence.
 */

/** Charge une échéance de l'espace, ou lève `not_found`. */
async function load(ctx: FeatureContext, id: number): Promise<FinanceRecurringRow> {
    const row = await ctx.db.finance.findRecurring(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Échéance introuvable');
    return row;
}

export const financeRecurringListFeature: FeatureDefinition<
    typeof financeRecurringList.command,
    typeof financeRecurringList.input,
    typeof financeRecurringList.output
> = defineFeature({
    ...financeRecurringList,
    access: READ,
    handler: async (ctx) => {
        await postDueRecurring(ctx);
        const rows = await ctx.db.finance.listRecurring(ctx.workspaceId);
        return { recurrings: await decryptAll(financeCipher(ctx), rows, toRecurring) };
    }
});

export const financeRecurringAddFeature: FeatureDefinition<
    typeof financeRecurringAdd.command,
    typeof financeRecurringAdd.input,
    typeof financeRecurringAdd.output
> = defineFeature({
    ...financeRecurringAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const draft = input.recurring;
        await assertEntryConsistent(ctx, draft);
        if (draft.endDate !== null && draft.endDate < draft.nextDate) {
            throw new FeatureError('validation', 'La fin ne peut pas précéder la prochaine occurrence.');
        }
        const payload: StoredEntry = {
            label: draft.label.trim(),
            counterparty: draft.counterparty.trim(),
            note: draft.note
        };
        const id = await ctx.db.finance.createRecurring(ctx.workspaceId, {
            accountId: draft.accountId,
            transferAccountId: draft.transferAccountId,
            categoryId: draft.categoryId,
            kind: draft.kind,
            amount: draft.amount,
            vatAmount: draft.vatAmount,
            frequency: draft.frequency,
            interval: draft.interval,
            nextDate: draft.nextDate,
            anchorDay: anchorDayOf(draft.frequency, draft.nextDate),
            endDate: draft.endDate,
            automatic: draft.automatic,
            active: draft.active,
            content: await encryptJson(financeCipher(ctx), payload)
        });
        ctx.audit({
            action: 'finance.recurringAdd',
            description: 'Échéance créée',
            metadata: { recurringId: id, frequency: draft.frequency, automatic: draft.automatic }
        });
        return { recurring: toRecurring(await load(ctx, id), payload) };
    }
});

export const financeRecurringUpdateFeature: FeatureDefinition<
    typeof financeRecurringUpdate.command,
    typeof financeRecurringUpdate.input,
    typeof financeRecurringUpdate.output
> = defineFeature({
    ...financeRecurringUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await load(ctx, input.recurringId);
        const draft = input.recurring;
        await assertEntryConsistent(ctx, draft);
        if (draft.endDate !== null && draft.endDate < draft.nextDate) {
            throw new FeatureError('validation', 'La fin ne peut pas précéder la prochaine occurrence.');
        }
        const payload: StoredEntry = {
            label: draft.label.trim(),
            counterparty: draft.counterparty.trim(),
            note: draft.note
        };
        const updated = await ctx.db.finance.updateRecurring(input.recurringId, ctx.workspaceId, {
            accountId: draft.accountId,
            transferAccountId: draft.transferAccountId,
            categoryId: draft.categoryId,
            kind: draft.kind,
            amount: draft.amount,
            vatAmount: draft.vatAmount,
            frequency: draft.frequency,
            interval: draft.interval,
            nextDate: draft.nextDate,
            // Recalculé depuis la date affichée: si l'on déplace une échéance au
            // 15, c'est le 15 qui devient l'ancre, sans quoi elle repartirait au
            // jour d'origine à la période suivante.
            anchorDay: anchorDayOf(draft.frequency, draft.nextDate),
            endDate: draft.endDate,
            automatic: draft.automatic,
            active: draft.active,
            content: await encryptJson(financeCipher(ctx), payload)
        });
        if (!updated) throw new FeatureError('not_found', 'Échéance introuvable');
        return { recurring: toRecurring(await load(ctx, input.recurringId), payload) };
    }
});

export const financeRecurringRemoveFeature: FeatureDefinition<
    typeof financeRecurringRemove.command,
    typeof financeRecurringRemove.input,
    typeof financeRecurringRemove.output
> = defineFeature({
    ...financeRecurringRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        await load(ctx, input.recurringId);
        // Les opérations déjà écrites par elle restent: elles ont eu lieu. Elles
        // perdent seulement leur rattachement (`ON DELETE SET NULL`).
        await ctx.db.finance.deleteRecurring(input.recurringId, ctx.workspaceId);
        ctx.audit({
            action: 'finance.recurringRemove',
            description: 'Échéance supprimée',
            metadata: { recurringId: input.recurringId }
        });
        return { recurringId: input.recurringId };
    }
});

/**
 * Écrit l'occurrence attendue maintenant, puis avance la date.
 *
 * C'est le clic que réclame une échéance non automatique. `amount` permet de
 * corriger au passage le montant d'une facture qui varie: c'est précisément ce
 * pour quoi une échéance est déclarée manuelle, et l'obliger à passer par la
 * modification du modèle changerait aussi toutes les occurrences suivantes.
 */
export const financeRecurringPostFeature: FeatureDefinition<
    typeof financeRecurringPost.command,
    typeof financeRecurringPost.input,
    typeof financeRecurringPost.output
> = defineFeature({
    ...financeRecurringPost,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await load(ctx, input.recurringId);
        if (row.active !== 1) throw new FeatureError('conflict', 'Cette échéance est suspendue.');

        const payload = await decryptJson<StoredEntry>(financeCipher(ctx), row.content);
        if (!payload) throw new FeatureError('internal', 'Échéance illisible');

        const date = row.next_date;
        const existing = await ctx.db.finance.findOccurrence(ctx.workspaceId, row.id, date);
        if (existing) throw new FeatureError('conflict', 'Cette occurrence a déjà été enregistrée.');

        const amount = input.amount ?? Number(row.amount);
        const id = await ctx.db.finance.createTransaction(ctx.workspaceId, {
            accountId: row.account_id,
            transferAccountId: row.transfer_account_id,
            categoryId: row.category_id,
            recurringId: row.id,
            kind: row.kind,
            amount,
            vatAmount: row.vat_amount === null ? null : Number(row.vat_amount),
            date,
            cleared: false,
            content: row.content
        });

        const next = nextOccurrence(date, row.frequency, row.interval_count, row.anchor_day);
        const finished = row.end_date !== null && next > row.end_date;
        await ctx.db.finance.advanceRecurring(row.id, ctx.workspaceId, next, date, finished ? false : null);

        const created = await ctx.db.finance.findTransaction(id, ctx.workspaceId);
        if (!created) throw new FeatureError('internal', 'Opération introuvable après création');
        ctx.audit({
            action: 'finance.recurringPost',
            description: 'Échéance enregistrée',
            metadata: { recurringId: row.id, transactionId: id, amount }
        });
        return {
            transaction: toTransaction(created, payload),
            recurring: toRecurring(await load(ctx, row.id), payload)
        };
    }
});

/** Passe l'occurrence attendue sans rien écrire, et avance à la suivante. */
export const financeRecurringSkipFeature: FeatureDefinition<
    typeof financeRecurringSkip.command,
    typeof financeRecurringSkip.input,
    typeof financeRecurringSkip.output
> = defineFeature({
    ...financeRecurringSkip,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await load(ctx, input.recurringId);
        const next = nextOccurrence(row.next_date, row.frequency, row.interval_count, row.anchor_day);
        const finished = row.end_date !== null && next > row.end_date;
        // `null` en date de dernière écriture: sauter n'écrit rien, et prétendre
        // le contraire ferait mentir la fiche de l'échéance.
        await ctx.db.finance.advanceRecurring(row.id, ctx.workspaceId, next, null, finished ? false : null);
        const payload = await decryptJson<StoredEntry>(financeCipher(ctx), row.content);
        return { recurring: toRecurring(await load(ctx, row.id), payload) };
    }
});
