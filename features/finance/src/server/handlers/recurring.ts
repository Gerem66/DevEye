import {
    financeRecurringAdd,
    financeRecurringList,
    financeRecurringPost,
    financeRecurringRemove,
    financeRecurringSkip,
    financeRecurringUpdate
} from '../../contracts/commands';
import type { FinanceRecurringRow } from '../../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    anchorDayOf,
    assertEntryConsistent,
    decryptAll,
    decryptJson,
    encryptJson,
    financeCipher,
    nextOccurrence,
    toRecurring,
    toTransaction,
    WRITE,
    type Ctx,
    type StoredEntry
} from '../_shared';
import { catchUp } from '../sources';

/**
 * Les échéances. Aucune tâche de fond : `postDueRecurring` (voir `_shared.ts`),
 * par `catchUp`, écrit ce qui manque en tête de chaque lecture. Ici, seulement
 * les gestes explicites.
 */

/** Charge une échéance de l'espace, ou lève `not_found`. */
async function load(ctx: Ctx, id: number): Promise<FinanceRecurringRow> {
    const row = await ctx.repo.findRecurring(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Échéance introuvable');
    return row;
}

export const financeRecurringListFeature = defineSdkFeature({
    ...financeRecurringList,
    handler: async (ctx: Ctx) => {
        await catchUp(ctx);
        const rows = await ctx.repo.listRecurring(ctx.workspaceId);
        return { recurrings: await decryptAll(financeCipher(ctx), rows, toRecurring) };
    }
});

export const financeRecurringAddFeature = defineSdkFeature({
    ...financeRecurringAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
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
        const id = await ctx.repo.createRecurring(ctx.workspaceId, {
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

export const financeRecurringUpdateFeature = defineSdkFeature({
    ...financeRecurringUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
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
        const updated = await ctx.repo.updateRecurring(input.recurringId, ctx.workspaceId, {
            accountId: draft.accountId,
            transferAccountId: draft.transferAccountId,
            categoryId: draft.categoryId,
            kind: draft.kind,
            amount: draft.amount,
            vatAmount: draft.vatAmount,
            frequency: draft.frequency,
            interval: draft.interval,
            nextDate: draft.nextDate,
            // Recalculé depuis la date affichée : déplacer une échéance au 15 fait du 15 l'ancre.
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

export const financeRecurringRemoveFeature = defineSdkFeature({
    ...financeRecurringRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        await load(ctx, input.recurringId);
        // Les opérations déjà écrites par elle restent: elles ont eu lieu. Elles
        // perdent seulement leur rattachement (`ON DELETE SET NULL`).
        await ctx.repo.deleteRecurring(input.recurringId, ctx.workspaceId);
        ctx.audit({
            action: 'finance.recurringRemove',
            description: 'Échéance supprimée',
            metadata: { recurringId: input.recurringId }
        });
        return { recurringId: input.recurringId };
    }
});

/**
 * Le clic d'une échéance manuelle. `amount` corrige au passage une facture qui
 * varie sans toucher au modèle.
 */
export const financeRecurringPostFeature = defineSdkFeature({
    ...financeRecurringPost,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const row = await load(ctx, input.recurringId);
        if (row.active !== 1) throw new FeatureError('conflict', 'Cette échéance est suspendue.');

        const payload = await decryptJson<StoredEntry>(financeCipher(ctx), row.content);
        if (!payload) throw new FeatureError('internal', 'Échéance illisible');

        const date = row.next_date;
        const existing = await ctx.repo.findOccurrence(ctx.workspaceId, row.id, date);
        if (existing) throw new FeatureError('conflict', 'Cette occurrence a déjà été enregistrée.');

        const amount = input.amount ?? Number(row.amount);
        // Un montant corrigé garde le taux du modèle : sa TVA suit, au lieu de
        // rester celle d'un autre montant.
        const vatAmount =
            row.vat_amount === null || Number(row.amount) === 0
                ? null
                : Math.round((Number(row.vat_amount) * amount) / Number(row.amount));
        const id = await ctx.repo.createTransaction(ctx.workspaceId, {
            accountId: row.account_id,
            transferAccountId: row.transfer_account_id,
            categoryId: row.category_id,
            recurringId: row.id,
            source: null,
            sourceRef: null,
            kind: row.kind,
            amount,
            vatAmount,
            date,
            cleared: false,
            content: row.content
        });

        const next = nextOccurrence(date, row.frequency, row.interval_count, row.anchor_day);
        const finished = row.end_date !== null && next > row.end_date;
        await ctx.repo.advanceRecurring(row.id, ctx.workspaceId, next, date, finished ? false : null);

        const created = await ctx.repo.findTransaction(id, ctx.workspaceId);
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
export const financeRecurringSkipFeature = defineSdkFeature({
    ...financeRecurringSkip,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const row = await load(ctx, input.recurringId);
        const next = nextOccurrence(row.next_date, row.frequency, row.interval_count, row.anchor_day);
        const finished = row.end_date !== null && next > row.end_date;
        // `null` en date de dernière écriture: sauter n'écrit rien, et prétendre
        // le contraire ferait mentir la fiche de l'échéance.
        await ctx.repo.advanceRecurring(row.id, ctx.workspaceId, next, null, finished ? false : null);
        const payload = await decryptJson<StoredEntry>(financeCipher(ctx), row.content);
        return { recurring: toRecurring(await load(ctx, row.id), payload) };
    }
});
