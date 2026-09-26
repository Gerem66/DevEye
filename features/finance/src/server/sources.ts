import type { InvoicingLedgerPayment } from '@deveye/types/sdk';

import {
    addDays,
    decryptJson,
    encryptJson,
    financeCipher,
    INVOICING_SOURCE,
    invoicingLedger,
    isDuplicate,
    postDueRecurring,
    type LedgerIo,
    type StoredEntry
} from './_shared';
import { reconcileAccount } from './reconcile';

/**
 * Une recette déjà saisie à la main est reconnue comme la copie d'un règlement
 * si elle tombe à ce nombre de jours près : le jour où l'on note un virement
 * n'est pas toujours celui que Facturation retient.
 */
const ADOPT_WINDOW_DAYS = 3;

/**
 * Tout ce dont une lecture a besoin avant de montrer un montant : les échéances
 * dues écrites, puis les règlements de Facturation recopiés. Une panne de
 * Facturation n'empêche jamais le livre de s'ouvrir.
 */
export async function catchUp(ctx: LedgerIo): Promise<void> {
    await postDueRecurring(ctx);
    try {
        await syncInvoicing(ctx);
    } catch (error) {
        ctx.logger.warn({ err: error }, 'finance: recopie des règlements de Facturation interrompue');
    }
}

/**
 * Recopie dans le livre les règlements saisis dans Facturation, à la lecture et
 * non par une tâche de fond, comme les échéances : la lecture qui suit un
 * règlement le trouve, et un serveur éteint une semaine rattrape tout.
 *
 * Le coût quand rien n'a bougé, c'est-à-dire presque toujours : la ligne de
 * réglages, le compte, et la version de Facturation (une requête sur un index).
 * La comparaison complète ne tourne que quand cette version, la devise, le
 * compte qui reçoit ou son jour de départ ont changé.
 *
 * Une copie disparaît avec son règlement, et aussi quand elle précède le jour de
 * départ du compte qui reçoit : ce solde la compte déjà. Deux lectures
 * simultanées insèrent la même copie : l'index unique `(source, source_ref)`
 * refuse la seconde, traitée comme un succès.
 */
export async function syncInvoicing(ctx: LedgerIo): Promise<void> {
    const ledger = invoicingLedger(ctx);
    if (ledger === null) return;
    const config = await ctx.repo.getConfig(ctx.workspaceId);
    const accountId = config?.invoicing_account_id ?? null;
    if (config === null || accountId === null) return;
    const account = await ctx.repo.findAccountPlain(accountId, ctx.workspaceId);
    if (account === null) return;

    const [remoteVersion, profile] = await Promise.all([
        ledger.version(ctx.workspaceId),
        ledger.profile(ctx.workspaceId)
    ]);
    const version = `${remoteVersion}|${profile.currency}|${accountId}|${account.opened_on}`;
    if (version === config.invoicing_version) return;

    const [remote, local] = await Promise.all([
        ledger.payments(ctx.workspaceId, null),
        ctx.repo.listSourced(ctx.workspaceId, INVOICING_SOURCE)
    ]);
    const byRef = new Map(remote.map((payment) => [String(payment.paymentId), payment]));
    const localRefs = new Set(local.map((row) => row.source_ref));

    for (const row of local) {
        const payment = byRef.get(row.source_ref);
        const beforeStart = row.account_id === accountId && row.date < account.opened_on;
        if (payment === undefined || beforeStart) {
            await ctx.repo.deleteTransaction(row.id, ctx.workspaceId);
            continue;
        }
        const vat = vatOf(payment);
        if (
            Number(row.amount) !== payment.amountCents ||
            row.date !== payment.paidOn ||
            nullableNumber(row.vat_amount) !== vat
        ) {
            await ctx.repo.updateSourcedFacts(row.id, ctx.workspaceId, {
                amount: payment.amountCents,
                vatAmount: vat,
                date: payment.paidOn
            });
        }
    }

    const missing = remote.filter(
        (payment) =>
            !localRefs.has(String(payment.paymentId)) &&
            payment.paidOn >= account.opened_on &&
            // Un règlement dans une autre devise fausserait les soldes : il reste dans Facturation.
            payment.currency === profile.currency
    );
    if (missing.length > 0) {
        const cipher = financeCipher(ctx);
        const names = await ledger.clientNames(ctx.workspaceId, [...new Set(missing.map((p) => p.docId))]);
        // Au premier passage seulement : ce qu'on avait noté à la main avant de
        // relier Facturation devient la copie, au lieu d'être compté deux fois.
        const firstPass = config.invoicing_version === null && local.length === 0;

        for (const payment of missing) {
            const origin = { docNumber: payment.docNumber, segment: payment.segment };
            if (firstPass && (await adopted(ctx, accountId, payment, origin))) continue;

            const payload: StoredEntry = {
                label: payment.docNumber === '' ? 'Règlement de facture' : `Facture ${payment.docNumber}`,
                counterparty: names.get(payment.docId) ?? '',
                note: '',
                origin
            };
            try {
                await ctx.repo.createTransaction(ctx.workspaceId, {
                    accountId,
                    transferAccountId: null,
                    categoryId: config.invoicing_category_id,
                    recurringId: null,
                    source: INVOICING_SOURCE,
                    sourceRef: String(payment.paymentId),
                    kind: 'income',
                    amount: payment.amountCents,
                    vatAmount: vatOf(payment),
                    date: payment.paidOn,
                    // Personne ne l'a encore vue sur un relevé.
                    cleared: false,
                    content: await encryptJson(cipher, payload)
                });
            } catch (error) {
                if (!isDuplicate(error)) throw error;
            }
        }
        // Un règlement arrivé après le relevé confirme la ligne qui l'attendait.
        await reconcileAccount(ctx, accountId);
    }

    await ctx.repo.setInvoicingVersion(ctx.workspaceId, version);
}

/** Une saisie à la main, seule candidate, devient la copie du règlement. Rend `true` si c'est fait. */
async function adopted(
    ctx: LedgerIo,
    accountId: number,
    payment: InvoicingLedgerPayment,
    origin: { docNumber: string; segment: string }
): Promise<boolean> {
    const candidates = await ctx.repo.listAdoptable(
        ctx.workspaceId,
        accountId,
        payment.amountCents,
        addDays(payment.paidOn, -ADOPT_WINDOW_DAYS),
        addDays(payment.paidOn, ADOPT_WINDOW_DAYS)
    );
    // Deux candidates : laquelle ? Mieux vaut un doublon visible qu'une erreur silencieuse.
    if (candidates.length !== 1) return false;
    const [row] = candidates;
    const cipher = financeCipher(ctx);
    const stored = await decryptJson<StoredEntry>(cipher, row.content);
    const payload: StoredEntry = {
        label: stored?.label ?? '',
        counterparty: stored?.counterparty ?? '',
        note: stored?.note ?? '',
        origin
    };
    await ctx.repo.adopt(
        row.id,
        ctx.workspaceId,
        INVOICING_SOURCE,
        String(payment.paymentId),
        await encryptJson(cipher, payload)
    );
    if (
        Number(row.amount) !== payment.amountCents ||
        row.date !== payment.paidOn ||
        nullableNumber(row.vat_amount) !== vatOf(payment)
    ) {
        await ctx.repo.updateSourcedFacts(row.id, ctx.workspaceId, {
            amount: payment.amountCents,
            vatAmount: vatOf(payment),
            date: payment.paidOn
        });
    }
    return true;
}

/** Une part de taxe nulle se stocke `null` : le livre ne suit pas « zéro » de TVA, il n'en suit pas. */
function vatOf(payment: InvoicingLedgerPayment): number | null {
    return payment.vatCents > 0 ? payment.vatCents : null;
}

function nullableNumber(value: number | null): number | null {
    return value === null ? null : Number(value);
}
