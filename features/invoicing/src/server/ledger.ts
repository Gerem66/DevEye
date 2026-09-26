import type { InvoicingLedgerPayment, InvoicingLedgerProvider, InvoicingLedgerReceivable } from '@deveye/types/sdk';

import { isOverdue, todayIn } from '../contracts/calendar';
import { DEFAULT_SETTINGS } from '../contracts/defaults';
import { docSegment, invoicingClientContentSchema, paymentMethodSchema, vatRegimeSchema } from '../contracts/domain';
import { paymentVatCents, remainingCents } from '../contracts/money';
import { openJson, type RepoIo } from './_shared';

/**
 * Au-delà, une créance de plus ne change plus rien à ce qu'un tableau de bord
 * en montre : il en cite quelques-unes et en somme le reste.
 */
const RECEIVABLES_MAX = 500;

/**
 * L'argent que Facturation connaît déjà, pour Finances (`INVOICING_LEDGER_PROVIDER`).
 * Rien ici n'écrit : Finances lit et recopie dans son livre. Tout est relu de
 * la base à chaque appel, jamais gardé : le fournisseur n'a pas d'état.
 */
export function createLedgerProvider(ioFor: (workspaceId: number) => RepoIo): InvoicingLedgerProvider {
    async function names(io: RepoIo, docIds: readonly number[]): Promise<Map<number, string>> {
        const snapshots = await io.repo.clientSnapshotsOf(io.workspaceId, docIds);
        const names = new Map<number, string>();
        for (const [docId, snapshot] of snapshots) {
            const client = await openJson(io, snapshot, invoicingClientContentSchema, null);
            names.set(docId, client?.name ?? '');
        }
        return names;
    }

    return {
        version: (workspaceId) => ioFor(workspaceId).repo.ledgerVersion(workspaceId),

        async payments(workspaceId, from) {
            const rows = await ioFor(workspaceId).repo.ledgerPayments(workspaceId, from);
            return rows.map((row): InvoicingLedgerPayment => ({
                paymentId: row.id,
                docId: row.doc_id,
                paidOn: row.paid_on,
                amountCents: Number(row.amount),
                vatCents: paymentVatCents(Number(row.amount), Number(row.total_vat ?? 0), Number(row.total_gross ?? 0)),
                method: paymentMethodSchema.catch('other').parse(row.method),
                currency: row.currency,
                docNumber: row.number_label ?? '',
                segment: docSegment(row.doc_id)
            }));
        },

        async clientNames(workspaceId, docIds) {
            return names(ioFor(workspaceId), docIds);
        },

        async receivables(workspaceId) {
            const io = ioFor(workspaceId);
            const settings = await io.repo.getSettings(workspaceId);
            const today = todayIn(settings?.time_zone ?? DEFAULT_SETTINGS.timeZone);
            const page = await io.repo.listDocs(
                workspaceId,
                {
                    kind: 'invoice',
                    status: 'issued',
                    derived: 'unpaid',
                    clientId: null,
                    year: null,
                    search: '',
                    limit: RECEIVABLES_MAX,
                    offset: 0
                },
                today
            );
            if (page.rows.length === 0) return [];

            const ids = page.rows.map((row) => row.id);
            const [settled, clients] = await Promise.all([io.repo.settledOf(ids, workspaceId), names(io, ids)]);

            const receivables: InvoicingLedgerReceivable[] = [];
            for (const row of page.rows) {
                const gross = Number(row.total_gross ?? 0);
                const done = settled.get(row.id);
                const remaining = remainingCents({
                    grossCents: gross,
                    paidCents: done?.paidCents ?? 0,
                    creditedCents: done?.creditedCents ?? 0,
                    deductedCents: done?.deductedCents ?? 0
                });
                if (remaining <= 0 || row.issued_on === null) continue;
                receivables.push({
                    docId: row.id,
                    docNumber: row.number_label ?? '',
                    clientName: clients.get(row.id) ?? '',
                    currency: row.currency,
                    issuedOn: row.issued_on,
                    dueOn: row.due_on,
                    remainingCents: remaining,
                    remainingVatCents: paymentVatCents(remaining, Number(row.total_vat ?? 0), gross),
                    overdue: isOverdue(row.due_on, today),
                    segment: docSegment(row.id)
                });
            }
            // Sans échéance, une créance se range après toutes celles qui en ont une.
            return receivables.sort((a, b) => (a.dueOn ?? '9999-12-31').localeCompare(b.dueOn ?? '9999-12-31'));
        },

        async profile(workspaceId) {
            const row = await ioFor(workspaceId).repo.getSettings(workspaceId);
            if (row === null) return { currency: DEFAULT_SETTINGS.currency, vatRegime: DEFAULT_SETTINGS.vatRegime };
            return {
                currency: row.currency,
                vatRegime: vatRegimeSchema.catch(DEFAULT_SETTINGS.vatRegime).parse(row.vat_regime)
            };
        }
    };
}
