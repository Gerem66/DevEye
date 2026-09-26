import { addDays, todayIn } from '../contracts/calendar';
import { paymentVatCents, remainingCents } from '../contracts/money';
import type {
    InvoicingClientRow,
    InvoicingClientUsage,
    InvoicingDocRow,
    InvoicingLineRow,
    InvoicingRepo,
    InvoicingSettled,
    InvoicingSettingsRow
} from './repo';

/**
 * Un dépôt en mémoire, pour les tests des handlers : le harnais du SDK fournit
 * tout le reste du contexte, et rien ici ne touche à une base.
 *
 * Ce qu'il ne prouve pas : que le SQL du vrai dépôt dit la même chose. Les
 * agrégats sont réécrits ici en TypeScript, et seule une base réelle peut les
 * confronter. Ce qu'il prouve, et qui est l'essentiel, c'est la logique des
 * handlers : les gardes, les transitions, les refus, les arrondis.
 */

export type MemoryDoc = InvoicingDocRow & { workspace_id: number };
export type MemoryLine = InvoicingLineRow & { workspace_id: number };

export interface MemoryStore {
    settings: Map<number, InvoicingSettingsRow>;
    clients: Map<number, InvoicingClientRow & { workspace_id: number }>;
    docs: MemoryDoc[];
    lines: MemoryLine[];
    payments: {
        id?: number;
        doc_id: number;
        workspace_id: number;
        amount: number;
        paid_on: string;
        method?: string;
        content?: string;
    }[];
    deductions: { doc_id: number; workspace_id: number; deducted_doc_id: number; amount: number }[];
    nextId: number;
}

export function emptyStore(): MemoryStore {
    return {
        settings: new Map(),
        clients: new Map(),
        docs: [],
        lines: [],
        payments: [],
        deductions: [],
        nextId: 1
    };
}

/**
 * Une ligne de document toute faite, pour que les tests ne récitent pas vingt
 * colonnes. Ses dates sont **relatives au jour courant** : écrites en dur, elles
 * feraient tomber les tests le jour où l'échéance serait passée.
 */
export function docRow(over: Partial<MemoryDoc> = {}): MemoryDoc {
    const day = todayIn('Europe/Paris');
    const year = Number(day.slice(0, 4));
    return {
        id: 100,
        workspace_id: 1,
        client_id: 1,
        kind: 'invoice',
        parent_doc_id: null,
        is_deposit: 0,
        status: 'issued',
        seq_year: year,
        number: 1,
        number_label: `F${year}-0001`,
        issued_on: day,
        due_on: addDays(day, 30),
        valid_until: null,
        performed_on: null,
        currency: 'EUR',
        vat_regime: 'standard',
        total_net: 100_000,
        total_vat: 20_000,
        total_gross: 120_000,
        public_token: null,
        accepted_at: null,
        sent_at: null,
        reminded_at: null,
        issuer_snapshot: null,
        client_snapshot: null,
        content: '{}',
        updated: 0,
        ...over
    };
}

function settledOfDoc(store: MemoryStore, doc: MemoryDoc): InvoicingSettled {
    return {
        paidCents: store.payments.filter((p) => p.doc_id === doc.id).reduce((sum, p) => sum + p.amount, 0),
        creditedCents: store.docs
            .filter((d) => d.parent_doc_id === doc.id && d.kind === 'credit' && d.status === 'issued')
            .reduce((sum, d) => sum + (d.total_gross ?? 0), 0),
        deductedCents: store.deductions.filter((x) => x.doc_id === doc.id).reduce((sum, x) => sum + x.amount, 0)
    };
}

function restOf(store: MemoryStore, doc: MemoryDoc): number {
    return remainingCents({ grossCents: doc.total_gross ?? 0, ...settledOfDoc(store, doc) });
}

export function memoryRepo(store: MemoryStore = emptyStore()): InvoicingRepo & { store: MemoryStore } {
    const openInvoices = (workspaceId: number) =>
        store.docs.filter((d) => d.workspace_id === workspaceId && d.kind === 'invoice' && d.status === 'issued');

    const strip = <T extends { workspace_id: number }>(row: T): Omit<T, 'workspace_id'> => {
        const { workspace_id: _ws, ...rest } = row;
        return rest;
    };

    return {
        store,

        getSettings: async (workspaceId) => store.settings.get(workspaceId) ?? null,

        saveSettings: async (workspaceId, row) => {
            store.settings.set(workspaceId, { ...row });
        },

        clearDomain: async (domainId, workspaceId) => {
            const row = store.settings.get(workspaceId);
            if (row?.domain_id === domainId) store.settings.set(workspaceId, { ...row, domain_id: null });
        },

        outstanding: async (workspaceId, today) => {
            let outstandingCents = 0;
            let overdueCents = 0;
            let overdueCount = 0;
            for (const doc of openInvoices(workspaceId)) {
                const rest = restOf(store, doc);
                outstandingCents += rest;
                if (doc.due_on !== null && doc.due_on < today) {
                    overdueCents += rest;
                    if (rest > 0) overdueCount += 1;
                }
            }
            return { outstandingCents, overdueCents, overdueCount };
        },

        toBill: async (workspaceId) => {
            const quotes = store.docs.filter(
                (d) =>
                    d.workspace_id === workspaceId &&
                    d.kind === 'quote' &&
                    d.status === 'accepted' &&
                    !store.docs.some((i) => i.parent_doc_id === d.id && i.kind === 'invoice' && i.status !== 'draft')
            );
            return {
                cents: quotes.reduce((sum, d) => sum + (d.total_gross ?? 0), 0),
                count: quotes.length
            };
        },

        countDrafts: async (workspaceId) =>
            store.docs.filter((d) => d.workspace_id === workspaceId && d.status === 'draft').length,

        countIssuedSince: async (workspaceIds, from, kind) =>
            store.docs.filter(
                (d) =>
                    workspaceIds.includes(d.workspace_id) &&
                    d.kind === kind &&
                    d.status !== 'draft' &&
                    d.issued_on !== null &&
                    d.issued_on >= from
            ).length,

        listClients: async (workspaceId, includeArchived) =>
            [...store.clients.values()]
                .filter((c) => c.workspace_id === workspaceId && (includeArchived || c.archived === 0))
                .sort((a, b) => b.id - a.id)
                .map(strip),

        findClient: async (id, workspaceId) => {
            const row = store.clients.get(id);
            return row && row.workspace_id === workspaceId ? strip(row) : null;
        },

        clientUsage: async (workspaceId, today) => {
            const usage = new Map<number, InvoicingClientUsage>();
            for (const doc of store.docs) {
                if (doc.workspace_id !== workspaceId || doc.client_id === null) continue;
                const entry = usage.get(doc.client_id) ?? {
                    documents: 0,
                    billedCents: 0,
                    outstandingCents: 0,
                    overdueCents: 0,
                    lastIssuedOn: null as string | null
                };
                entry.documents += 1;
                if (doc.status === 'issued' && doc.kind === 'invoice') entry.billedCents += doc.total_gross ?? 0;
                if (doc.status === 'issued' && doc.kind === 'credit') entry.billedCents -= doc.total_gross ?? 0;
                if (doc.status !== 'draft' && doc.issued_on !== null) {
                    entry.lastIssuedOn =
                        entry.lastIssuedOn === null || doc.issued_on > entry.lastIssuedOn
                            ? doc.issued_on
                            : entry.lastIssuedOn;
                }
                if (doc.kind === 'invoice' && doc.status === 'issued') {
                    const rest = restOf(store, doc);
                    entry.outstandingCents += rest;
                    if (doc.due_on !== null && doc.due_on < today) entry.overdueCents += rest;
                }
                usage.set(doc.client_id, entry);
            }
            for (const entry of usage.values()) entry.billedCents = Math.max(0, entry.billedCents);
            return usage;
        },

        insertClient: async (workspaceId, row) => {
            const id = store.nextId++;
            store.clients.set(id, { id, workspace_id: workspaceId, ...row });
            return id;
        },

        updateClient: async (id, workspaceId, row) => {
            const current = store.clients.get(id);
            if (!current || current.workspace_id !== workspaceId) return 0;
            store.clients.set(id, { ...current, ...row });
            return 1;
        },

        deleteClient: async (id, workspaceId) => {
            const current = store.clients.get(id);
            if (!current || current.workspace_id !== workspaceId) return 0;
            store.clients.delete(id);
            return 1;
        },

        countDocsOfClient: async (id, workspaceId) =>
            store.docs.filter((d) => d.client_id === id && d.workspace_id === workspaceId).length,

        listDocs: async (workspaceId, filter, today) => {
            let docs = store.docs.filter((d) => d.workspace_id === workspaceId);
            if (filter.kind !== null) docs = docs.filter((d) => d.kind === filter.kind);
            if (filter.status !== null) docs = docs.filter((d) => d.status === filter.status);
            if (filter.clientId !== null) docs = docs.filter((d) => d.client_id === filter.clientId);
            if (filter.year !== null) {
                docs = docs.filter((d) => d.issued_on !== null && Number(d.issued_on.slice(0, 4)) === filter.year);
            }
            if (filter.search.length > 0) {
                docs = docs.filter((d) => (d.number_label ?? '').includes(filter.search));
            }
            if (filter.derived === 'overdue') {
                docs = docs.filter(
                    (d) =>
                        d.kind === 'invoice' &&
                        d.status === 'issued' &&
                        d.due_on !== null &&
                        d.due_on < today &&
                        restOf(store, d) > 0
                );
            } else if (filter.derived === 'unpaid') {
                docs = docs.filter((d) => d.kind === 'invoice' && d.status === 'issued' && restOf(store, d) > 0);
            } else if (filter.derived === 'expired') {
                docs = docs.filter(
                    (d) => d.kind === 'quote' && d.status === 'sent' && d.valid_until !== null && d.valid_until < today
                );
            }

            const sorted = [...docs].sort((a, b) => {
                const left = a.issued_on ?? '9999-12-31';
                const right = b.issued_on ?? '9999-12-31';
                return left === right ? b.id - a.id : left < right ? 1 : -1;
            });

            let outstandingCents = 0;
            let overdueCents = 0;
            for (const doc of sorted) {
                if (doc.kind !== 'invoice' || doc.status !== 'issued') continue;
                const rest = restOf(store, doc);
                outstandingCents += rest;
                if (doc.due_on !== null && doc.due_on < today) overdueCents += rest;
            }

            return {
                rows: sorted.slice(filter.offset, filter.offset + filter.limit).map(strip),
                count: sorted.length,
                outstandingCents,
                overdueCents
            };
        },

        findDoc: async (id, workspaceId) => {
            const row = store.docs.find((d) => d.id === id && d.workspace_id === workspaceId);
            return row ? strip(row) : null;
        },

        insertDoc: async (workspaceId, row, at) => {
            const id = store.nextId++;
            store.docs.push(
                docRow({
                    ...row,
                    id,
                    workspace_id: workspaceId,
                    status: 'draft',
                    seq_year: null,
                    number: null,
                    number_label: null,
                    issued_on: null,
                    total_net: null,
                    total_vat: null,
                    total_gross: null,
                    updated: at
                })
            );
            return id;
        },

        updateDocDraft: async (id, workspaceId, patch, at) => {
            const doc = store.docs.find((d) => d.id === id && d.workspace_id === workspaceId && d.status === 'draft');
            if (!doc) return 0;
            Object.assign(doc, patch, { updated: at });
            return 1;
        },

        deleteDoc: async (id, workspaceId) => {
            const index = store.docs.findIndex(
                (d) => d.id === id && d.workspace_id === workspaceId && d.status === 'draft' && d.number === null
            );
            if (index === -1) return 0;
            store.docs.splice(index, 1);
            store.lines = store.lines.filter((l) => l.doc_id !== id);
            return 1;
        },

        listLines: async (docIds, workspaceId) =>
            store.lines
                .filter((l) => l.workspace_id === workspaceId && docIds.includes(l.doc_id))
                .sort((a, b) =>
                    a.doc_id === b.doc_id ? a.sort_order - b.sort_order || a.id - b.id : a.doc_id - b.doc_id
                )
                .map(strip),

        setLines: async (docId, workspaceId, lines) => {
            const doc = store.docs.find((d) => d.id === docId && d.workspace_id === workspaceId);
            if (!doc || doc.status !== 'draft') return;
            const kept = new Set(lines.filter((line) => line.id !== null).map((line) => line.id as number));
            store.lines = store.lines.filter((l) => l.doc_id !== docId || kept.has(l.id));
            for (const line of lines) {
                if (line.id === null) {
                    store.lines.push({
                        id: store.nextId++,
                        doc_id: docId,
                        workspace_id: workspaceId,
                        sort_order: line.sort_order,
                        kind: line.kind,
                        quantity_milli: line.quantity_milli,
                        unit: line.unit,
                        unit_price: line.unit_price,
                        vat_bp: line.vat_bp,
                        net_amount: null,
                        content: line.content
                    });
                } else {
                    const current = store.lines.find((l) => l.id === line.id && l.doc_id === docId);
                    if (current) Object.assign(current, line, { id: current.id });
                }
            }
        },

        settledOf: async (docIds, workspaceId) => {
            const settled = new Map<number, InvoicingSettled>();
            for (const doc of store.docs) {
                if (doc.workspace_id !== workspaceId || !docIds.includes(doc.id)) continue;
                settled.set(doc.id, settledOfDoc(store, doc));
            }
            return settled;
        },

        maxNumber: async (workspaceId, kind, seqYear) =>
            store.docs
                .filter((d) => d.workspace_id === workspaceId && d.kind === kind && d.seq_year === seqYear)
                .reduce((top, d) => Math.max(top, d.number ?? 0), 0),

        lastIssuedOn: async (workspaceId, kind, seqYear) =>
            store.docs
                .filter(
                    (d) =>
                        d.workspace_id === workspaceId &&
                        d.kind === kind &&
                        d.seq_year === seqYear &&
                        d.issued_on !== null
                )
                .reduce<string | null>((last, d) => (last === null || d.issued_on! > last ? d.issued_on : last), null),

        reserveNumber: async (id, workspaceId, seqYear, value, label) => {
            const doc = store.docs.find((d) => d.id === id && d.workspace_id === workspaceId && d.number === null);
            if (!doc) return 0;
            // L'index unique de la base, rejoué : deux documents ne peuvent pas
            // porter le même rang dans la même séquence.
            const taken = store.docs.some(
                (d) =>
                    d.workspace_id === workspaceId &&
                    d.kind === doc.kind &&
                    d.seq_year === seqYear &&
                    d.number === value
            );
            if (taken) {
                const error = new Error('Duplicate entry') as Error & { code: string; errno: number };
                error.code = 'ER_DUP_ENTRY';
                error.errno = 1062;
                throw error;
            }
            doc.seq_year = seqYear;
            doc.number = value;
            doc.number_label = label;
            return 1;
        },

        issueDoc: async (id, workspaceId, input) => {
            const doc = store.docs.find((d) => d.id === id && d.workspace_id === workspaceId && d.status === 'draft');
            if (!doc) return 0;
            Object.assign(doc, input);
            return 1;
        },

        freezeLines: async (docId, workspaceId, lines) => {
            for (const entry of lines) {
                const line = store.lines.find(
                    (l) => l.id === entry.id && l.doc_id === docId && l.workspace_id === workspaceId
                );
                if (line) {
                    line.net_amount = entry.net;
                    line.vat_bp = entry.vatBp;
                }
            }
        },

        setStatus: async (id, workspaceId, from, to, at) => {
            const doc = store.docs.find((d) => d.id === id && d.workspace_id === workspaceId && d.status === from);
            if (!doc) return 0;
            doc.status = to;
            doc.updated = at;
            return 1;
        },

        findByToken: async (token) => store.docs.find((d) => d.public_token === token) ?? null,

        setToken: async (id, workspaceId, token) => {
            const doc = store.docs.find((d) => d.id === id && d.workspace_id === workspaceId);
            if (!doc) return 0;
            doc.public_token = token;
            return 1;
        },

        markSent: async (id, workspaceId, at) => {
            const doc = store.docs.find((d) => d.id === id && d.workspace_id === workspaceId);
            if (!doc) return 0;
            doc.sent_at = at;
            return 1;
        },

        overdueToRemind: async (today, staleBefore, limit) =>
            store.docs
                .filter(
                    (d) =>
                        d.kind === 'invoice' &&
                        d.status === 'issued' &&
                        d.due_on !== null &&
                        d.due_on < today &&
                        (d.reminded_at === null || d.reminded_at < staleBefore) &&
                        restOf(store, d) > 0
                )
                .sort((a, b) => ((a.due_on ?? '') < (b.due_on ?? '') ? -1 : 1))
                .slice(0, limit),

        markReminded: async (ids, at) => {
            for (const doc of store.docs) if (ids.includes(doc.id)) doc.reminded_at = at;
        },

        answerQuote: async (id, token, status, at, content) => {
            const doc = store.docs.find(
                (d) => d.id === id && d.public_token === token && d.kind === 'quote' && d.status === 'sent'
            );
            if (!doc) return 0;
            doc.status = status;
            doc.accepted_at = status === 'accepted' ? at : null;
            doc.content = content;
            doc.updated = at;
            return 1;
        },

        depositsOf: async (quoteId, workspaceId) =>
            store.docs
                .filter(
                    (d) =>
                        d.workspace_id === workspaceId &&
                        d.parent_doc_id === quoteId &&
                        d.kind === 'invoice' &&
                        d.is_deposit === 1 &&
                        d.status === 'issued'
                )
                .map(strip),

        insertDeduction: async (workspaceId, row) => {
            const current = store.deductions.find(
                (x) => x.doc_id === row.doc_id && x.deducted_doc_id === row.deducted_doc_id
            );
            if (current) current.amount = row.amount;
            else store.deductions.push({ ...row, workspace_id: workspaceId });
        },

        listDeductions: async (docId, workspaceId) =>
            store.deductions
                .filter((x) => x.doc_id === docId && x.workspace_id === workspaceId)
                .map((x) => ({ deducted_doc_id: x.deducted_doc_id, amount: x.amount })),

        listPayments: async (docId, workspaceId) =>
            store.payments
                .filter((p) => p.doc_id === docId && p.workspace_id === workspaceId)
                .map((p) => ({
                    id: p.id ?? 0,
                    doc_id: p.doc_id,
                    paid_on: p.paid_on,
                    amount: p.amount,
                    method: p.method ?? 'transfer',
                    content: p.content ?? '{}'
                }))
                .sort((a, b) => (a.paid_on === b.paid_on ? b.id - a.id : a.paid_on < b.paid_on ? 1 : -1)),

        insertPayment: async (workspaceId, row) => {
            const id = store.nextId++;
            store.payments.push({ ...row, id, workspace_id: workspaceId });
            return id;
        },

        deletePayment: async (id, docId, workspaceId) => {
            const index = store.payments.findIndex(
                (p) => p.id === id && p.doc_id === docId && p.workspace_id === workspaceId
            );
            if (index === -1) return 0;
            store.payments.splice(index, 1);
            return 1;
        },

        cashedBetween: async (workspaceId, from, to) => {
            let cents = 0;
            let vatCents = 0;
            for (const payment of store.payments) {
                if (payment.workspace_id !== workspaceId) continue;
                if (payment.paid_on < from || payment.paid_on > to) continue;
                cents += payment.amount;
                const doc = store.docs.find((d) => d.id === payment.doc_id);
                if (doc) vatCents += paymentVatCents(payment.amount, doc.total_vat ?? 0, doc.total_gross ?? 0);
            }
            return { cents, vatCents };
        },

        ledgerVersion: async (workspaceId) => {
            const mine = store.payments.filter((p) => p.workspace_id === workspaceId);
            return `${mine.length}:${Math.max(0, ...mine.map((p) => p.id ?? 0))}`;
        },

        ledgerPayments: async (workspaceId, from) =>
            store.payments
                .filter((p) => p.workspace_id === workspaceId && (from === null || p.paid_on >= from))
                .flatMap((p) => {
                    const doc = store.docs.find((d) => d.id === p.doc_id && d.workspace_id === workspaceId);
                    if (!doc) return [];
                    return [
                        {
                            id: p.id ?? 0,
                            doc_id: p.doc_id,
                            paid_on: p.paid_on,
                            amount: p.amount,
                            method: p.method ?? 'transfer',
                            number_label: doc.number_label,
                            currency: doc.currency,
                            total_vat: doc.total_vat,
                            total_gross: doc.total_gross
                        }
                    ];
                })
                .sort((a, b) => (a.paid_on === b.paid_on ? a.id - b.id : a.paid_on < b.paid_on ? -1 : 1)),

        clientSnapshotsOf: async (workspaceId, docIds) => {
            const snapshots = new Map<number, string>();
            for (const doc of store.docs) {
                if (doc.workspace_id === workspaceId && docIds.includes(doc.id) && doc.client_snapshot !== null) {
                    snapshots.set(doc.id, doc.client_snapshot);
                }
            }
            return snapshots;
        },

        billedBetween: async (workspaceId, from, to) => {
            const totals = { netCents: 0, vatCents: 0, grossCents: 0, count: 0 };
            for (const doc of store.docs) {
                if (doc.workspace_id !== workspaceId || doc.status !== 'issued') continue;
                if (doc.kind !== 'invoice' && doc.kind !== 'credit') continue;
                if (doc.issued_on === null || doc.issued_on < from || doc.issued_on > to) continue;
                const sign = doc.kind === 'credit' ? -1 : 1;
                totals.netCents += sign * (doc.total_net ?? 0);
                totals.vatCents += sign * (doc.total_vat ?? 0);
                totals.grossCents += sign * (doc.total_gross ?? 0);
                if (doc.kind === 'invoice') totals.count += 1;
            }
            return totals;
        },

        monthlySeries: async (workspaceId, from, to) => {
            const months = new Map<string, { month: string; billedCents: number; cashedCents: number }>();
            const at = (month: string) => {
                const entry = months.get(month) ?? { month, billedCents: 0, cashedCents: 0 };
                months.set(month, entry);
                return entry;
            };
            for (const doc of store.docs) {
                if (doc.workspace_id !== workspaceId || doc.status !== 'issued') continue;
                if (doc.issued_on === null || doc.issued_on < from || doc.issued_on > to) continue;
                if (doc.kind !== 'invoice' && doc.kind !== 'credit') continue;
                const entry = at(doc.issued_on.slice(0, 7));
                entry.billedCents += (doc.kind === 'credit' ? -1 : 1) * (doc.total_gross ?? 0);
            }
            for (const payment of store.payments) {
                if (payment.workspace_id !== workspaceId) continue;
                if (payment.paid_on < from || payment.paid_on > to) continue;
                at(payment.paid_on.slice(0, 7)).cashedCents += payment.amount;
            }
            for (const entry of months.values()) entry.billedCents = Math.max(0, entry.billedCents);
            return [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
        },

        quotesPending: async (workspaceId, today) => {
            let cents = 0;
            let count = 0;
            let expiring = 0;
            for (const doc of store.docs) {
                if (doc.workspace_id !== workspaceId || doc.kind !== 'quote' || doc.status !== 'sent') continue;
                if (doc.valid_until !== null && doc.valid_until < today) continue;
                cents += doc.total_gross ?? 0;
                count += 1;
                if (doc.valid_until !== null && doc.valid_until < addDays(today, 8)) expiring += 1;
            }
            return { cents, count, expiring };
        },

        actionable: async (workspaceId, today, soon, limit) =>
            store.docs
                .filter((doc) => {
                    if (doc.workspace_id !== workspaceId) return false;
                    if (doc.kind === 'invoice' && doc.status === 'issued') {
                        return doc.due_on !== null && doc.due_on < today && restOf(store, doc) > 0;
                    }
                    if (doc.kind === 'quote' && doc.status === 'sent') {
                        return doc.valid_until !== null && doc.valid_until >= today && doc.valid_until < soon;
                    }
                    if (doc.kind === 'quote' && doc.status === 'accepted') {
                        return !store.docs.some(
                            (i) => i.parent_doc_id === doc.id && i.kind === 'invoice' && i.status !== 'draft'
                        );
                    }
                    return false;
                })
                .sort((a, b) =>
                    (a.due_on ?? a.valid_until ?? a.issued_on ?? '') < (b.due_on ?? b.valid_until ?? b.issued_on ?? '')
                        ? -1
                        : 1
                )
                .slice(0, limit)
                .map(strip),

        numbersOf: async (ids, workspaceId) => {
            const numbers = new Map<number, string>();
            for (const doc of store.docs) {
                if (doc.workspace_id === workspaceId && ids.includes(doc.id) && doc.number_label !== null) {
                    numbers.set(doc.id, doc.number_label);
                }
            }
            return numbers;
        }
    };
}
