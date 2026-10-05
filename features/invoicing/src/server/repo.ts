import type { SdkQueryable } from '@deveye/types/sdk/server';

import { paymentVatCents } from '../contracts/money';

/**
 * Toutes les requêtes du module, et elles seules. Trois règles :
 *
 *  - le handle est délibérément ignorant de l'espace : **chaque** requête porte
 *    son `workspace_id` dans son `WHERE`, jamais un test au-dessus ;
 *  - un dépôt ne chiffre ni ne déchiffre jamais : il reçoit des blobs déjà
 *    scellés et les rend scellés ;
 *  - aucun `SELECT` étoile sur ces tables : les colonnes `DATE` doivent être
 *    projetées par `DATE_FORMAT`, sinon le pilote rend un objet `Date` recalé
 *    sur le fuseau du processus.
 */

export interface InvoicingSettingsRow {
    currency: string;
    time_zone: string;
    vat_regime: string;
    default_vat_bp: number;
    payment_terms_days: number;
    quote_validity_days: number;
    default_deposit_bp: number;
    quote_prefix: string;
    invoice_prefix: string;
    credit_prefix: string;
    number_reset: string;
    number_start: number;
    number_pad: number;
    mail_sender_id: number | null;
    domain_id: number | null;
    content: string;
}

export interface InvoicingClientRow {
    id: number;
    kind: string;
    payment_terms_days: number | null;
    default_vat_bp: number | null;
    archived: number;
    content: string;
}

export interface InvoicingClientUsage {
    documents: number;
    billedCents: number;
    outstandingCents: number;
    overdueCents: number;
    lastIssuedOn: string | null;
}

export interface InvoicingDocRow {
    id: number;
    client_id: number | null;
    kind: string;
    parent_doc_id: number | null;
    is_deposit: number;
    status: string;
    /** Sorti des listes et de l'accueil, toujours compté dans les chiffres. */
    archived: number;
    seq_year: number | null;
    number: number | null;
    number_label: string | null;
    issued_on: string | null;
    due_on: string | null;
    valid_until: string | null;
    deposit_bp: number | null;
    performed_on: string | null;
    currency: string;
    vat_regime: string;
    total_net: number | null;
    total_vat: number | null;
    total_gross: number | null;
    issuer_snapshot: string | null;
    client_snapshot: string | null;
    public_token: string | null;
    accepted_at: number | null;
    sent_at: number | null;
    reminded_at: number | null;
    content: string;
    updated: number;
}

export interface InvoicingLineRow {
    id: number;
    doc_id: number;
    sort_order: number;
    kind: string;
    quantity_milli: number;
    unit: string;
    unit_price: number;
    vat_bp: number;
    net_amount: number | null;
    content: string;
}

/** Ce qui éteint la créance d'un document : règlements, avoirs, acomptes déduits. */
export interface InvoicingSettled {
    paidCents: number;
    creditedCents: number;
    deductedCents: number;
}

export interface InvoicingDocFilter {
    /** `null` : archivés ou non. */
    archived: boolean | null;
    kind: string | null;
    status: string | null;
    derived: 'overdue' | 'unpaid' | 'expired' | null;
    clientId: number | null;
    year: number | null;
    search: string;
    limit: number;
    offset: number;
}

export interface InvoicingDocPage {
    rows: InvoicingDocRow[];
    count: number;
    outstandingCents: number;
    overdueCents: number;
}

export interface InvoicingOutstanding {
    outstandingCents: number;
    overdueCents: number;
    overdueCount: number;
}

export interface InvoicingRepo {
    getSettings(workspaceId: number): Promise<InvoicingSettingsRow | null>;
    saveSettings(workspaceId: number, row: InvoicingSettingsRow, at: number): Promise<void>;
    /** Le domaine retiré ne désigne plus rien : les liens repartent sur l'adresse de DevEye. */
    clearDomain(domainId: number, workspaceId: number): Promise<void>;
    /** Le reste dû de l'espace, et sa part échue au jour donné. */
    outstanding(workspaceId: number, today: string): Promise<InvoicingOutstanding>;
    /** Les devis acceptés dont aucune facture n'est encore sortie. */
    toBill(workspaceId: number): Promise<{ cents: number; count: number }>;
    countDrafts(workspaceId: number): Promise<number>;
    /**
     * Les documents d'un type émis depuis ce jour, sur tous les espaces donnés.
     * Les avoirs ne s'y demandent jamais : borner celui qui corrige une erreur
     * serait une pénalité pour bonne conduite.
     */
    countIssuedSince(workspaceIds: readonly number[], from: string, kind: string): Promise<number>;

    listClients(workspaceId: number, includeArchived: boolean): Promise<InvoicingClientRow[]>;
    findClient(id: number, workspaceId: number): Promise<InvoicingClientRow | null>;
    /** Ce que chaque client représente, par identifiant. Deux requêtes, jamais une par client. */
    clientUsage(workspaceId: number, today: string): Promise<Map<number, InvoicingClientUsage>>;
    insertClient(workspaceId: number, row: Omit<InvoicingClientRow, 'id'>, at: number): Promise<number>;
    /** Rend le nombre de lignes touchées : zéro dit « pas ici », pas « échec ». */
    updateClient(id: number, workspaceId: number, row: Omit<InvoicingClientRow, 'id'>, at: number): Promise<number>;
    deleteClient(id: number, workspaceId: number): Promise<number>;
    countDocsOfClient(id: number, workspaceId: number): Promise<number>;

    listDocs(workspaceId: number, filter: InvoicingDocFilter, today: string): Promise<InvoicingDocPage>;
    findDoc(id: number, workspaceId: number): Promise<InvoicingDocRow | null>;
    insertDoc(workspaceId: number, row: NewDoc, at: number): Promise<number>;
    /** L'en-tête d'un brouillon. La garde EST la requête : `WHERE status = 'draft'`. */
    updateDocDraft(id: number, workspaceId: number, patch: DocDraftPatch, at: number): Promise<number>;
    /** Un brouillon jamais numéroté. Un document émis ne se supprime pas. */
    deleteDoc(id: number, workspaceId: number): Promise<number>;
    /** Archive ou ressort un document émis. La garde EST la requête : jamais un brouillon. */
    setArchived(id: number, workspaceId: number, archived: boolean, at: number): Promise<number>;

    listLines(docIds: readonly number[], workspaceId: number): Promise<InvoicingLineRow[]>;
    /** La différence par identifiant, jamais un vidage suivi d'un remplissage. */
    setLines(docId: number, workspaceId: number, lines: readonly LineWrite[]): Promise<void>;

    /** Ce qui éteint la créance de chaque document donné. */
    settledOf(docIds: readonly number[], workspaceId: number): Promise<Map<number, InvoicingSettled>>;
    /** Le numéro des documents parents, pour dire « avoir sur la facture F2026-0007 ». */
    numbersOf(ids: readonly number[], workspaceId: number): Promise<Map<number, string>>;

    /** Le plus grand rang déjà attribué dans cette séquence, ou zéro. */
    maxNumber(workspaceId: number, kind: string, seqYear: number): Promise<number>;
    /** La date d'émission la plus récente de la séquence : un rang plus grand ne peut pas la précéder. */
    lastIssuedOn(workspaceId: number, kind: string, seqYear: number): Promise<string | null>;
    /**
     * Pose le rang sur un document qui n'en a pas encore. Rend zéro quand un
     * autre l'a devancé : l'index unique est le juge, et l'appelant reprend.
     */
    reserveNumber(id: number, workspaceId: number, seqYear: number, value: number, label: string): Promise<number>;
    /** Fige le document : ses totaux, ses instantanés, ses dates, son statut. */
    issueDoc(id: number, workspaceId: number, input: IssueWrite): Promise<number>;
    /**
     * Fige le hors taxe et le taux de chaque ligne, calculés une fois pour
     * toutes. Le taux aussi : un brouillon suit le régime vivant de l'espace, et
     * ce qu'il portait avant un passage en franchise ne doit pas survivre à son
     * émission.
     */
    freezeLines(
        docId: number,
        workspaceId: number,
        lines: readonly { id: number; net: number; vatBp: number }[]
    ): Promise<void>;
    /**
     * Le document que ce jeton désigne, sans espace en argument : le jeton EST
     * la clé, et son index unique porte sur toute la table.
     */
    findByToken(token: string): Promise<(InvoicingDocRow & { workspace_id: number }) | null>;
    setToken(id: number, workspaceId: number, token: string | null): Promise<number>;
    /** Pose la date d'envoi, sans rien changer d'autre. */
    markSent(id: number, workspaceId: number, at: number): Promise<number>;
    /**
     * Les factures échues et non soldées qu'on n'a pas encore relayées, ou plus
     * depuis un moment, hors archives : archiver, c'est classer l'affaire. Tous
     * espaces confondus : le service n'en vise aucun.
     */
    overdueToRemind(
        today: string,
        staleBefore: number,
        limit: number
    ): Promise<(InvoicingDocRow & { workspace_id: number })[]>;
    /** Marque la relance, que l'envoi ait eu lieu ou non. */
    markReminded(ids: readonly number[], at: number): Promise<void>;

    /**
     * La réponse en ligne d'un client, accord ou refus. Zéro : le devis n'était
     * plus en attente, et un second clic ne change rien.
     */
    answerQuote(
        id: number,
        token: string,
        status: 'accepted' | 'declined',
        at: number,
        content: string
    ): Promise<number>;

    /** Les acomptes déjà émis sur ce devis, pour que la facture de solde les déduise. */
    depositsOf(quoteId: number, workspaceId: number): Promise<InvoicingDocRow[]>;
    insertDeduction(workspaceId: number, row: NewDeduction, at: number): Promise<void>;
    listDeductions(docId: number, workspaceId: number): Promise<InvoicingDeductionRow[]>;

    /** Une transition gardée : zéro dit que l'état attendu n'était plus là. */
    setStatus(id: number, workspaceId: number, from: string, to: string, at: number): Promise<number>;

    listPayments(docId: number, workspaceId: number): Promise<InvoicingPaymentRow[]>;
    insertPayment(workspaceId: number, row: NewPayment, at: number): Promise<number>;
    deletePayment(id: number, docId: number, workspaceId: number): Promise<number>;

    /** Ce qui est entré en caisse sur la période, et la part de taxe qu'il porte. */
    cashedBetween(workspaceId: number, from: string, to: string): Promise<{ cents: number; vatCents: number }>;
    /**
     * Change dès qu'un règlement de l'espace apparaît ou disparaît : leur nombre
     * et le plus grand identifiant, que MySQL ne réattribue jamais. Servi par
     * l'index de l'espace seul.
     */
    ledgerVersion(workspaceId: number): Promise<string>;
    /** Les règlements reçus depuis `from` (tous si `null`), du plus ancien au plus récent, avec leur facture. */
    ledgerPayments(workspaceId: number, from: string | null): Promise<InvoicingLedgerRow[]>;
    /** Le client figé sur chacun de ces documents, scellé. */
    clientSnapshotsOf(workspaceId: number, docIds: readonly number[]): Promise<Map<number, string>>;
    /** Ce qui a été facturé sur la période, avoirs déduits. */
    billedBetween(
        workspaceId: number,
        from: string,
        to: string
    ): Promise<{ netCents: number; vatCents: number; grossCents: number; count: number }>;
    /** Douze mois de facturé et d'encaissé, pour la frise. */
    monthlySeries(workspaceId: number, from: string, to: string): Promise<InvoicingMonth[]>;
    /** Les devis envoyés qui tiennent encore. */
    quotesPending(workspaceId: number, today: string): Promise<{ cents: number; count: number; expiring: number }>;
    /** Ce qui demande un geste aujourd'hui, hors archives : les retards, puis les devis qui vont expirer. */
    actionable(workspaceId: number, today: string, soon: string, limit: number): Promise<InvoicingDocRow[]>;
}

export interface NewDeduction {
    doc_id: number;
    deducted_doc_id: number;
    amount: number;
}

export interface InvoicingDeductionRow {
    deducted_doc_id: number;
    amount: number;
}

export interface InvoicingPaymentRow {
    id: number;
    doc_id: number;
    paid_on: string;
    amount: number;
    method: string;
    content: string;
}

/** Un règlement, et ce que sa facture dit de lui : son numéro, sa devise, sa part de taxe. */
export interface InvoicingLedgerRow {
    id: number;
    doc_id: number;
    paid_on: string;
    amount: number;
    method: string;
    number_label: string | null;
    currency: string;
    total_vat: number | null;
    total_gross: number | null;
}

export interface NewPayment {
    doc_id: number;
    paid_on: string;
    amount: number;
    method: string;
    content: string;
}

export interface InvoicingMonth {
    month: string;
    billedCents: number;
    cashedCents: number;
}

export interface IssueWrite {
    status: string;
    /** Figé à l'émission : le régime de l'espace ce jour-là, non celui de la création. */
    vat_regime: string;
    issued_on: string;
    due_on: string | null;
    valid_until: string | null;
    deposit_bp: number | null;
    total_net: number;
    total_vat: number;
    total_gross: number;
    issuer_snapshot: string;
    client_snapshot: string;
    issued_by: number;
    updated: number;
}

export interface NewDoc {
    client_id: number | null;
    kind: string;
    parent_doc_id: number | null;
    is_deposit: number;
    currency: string;
    vat_regime: string;
    due_on: string | null;
    valid_until: string | null;
    deposit_bp: number | null;
    performed_on: string | null;
    content: string;
    created_by: number;
}

export interface DocDraftPatch {
    client_id: number | null;
    due_on: string | null;
    valid_until: string | null;
    deposit_bp: number | null;
    performed_on: string | null;
    content: string;
}

export interface LineWrite {
    id: number | null;
    sort_order: number;
    kind: string;
    quantity_milli: number;
    unit: string;
    unit_price: number;
    vat_bp: number;
    content: string;
}

const SETTINGS_COLUMNS = `currency, time_zone, vat_regime, default_vat_bp, payment_terms_days,
    quote_validity_days, default_deposit_bp, quote_prefix, invoice_prefix, credit_prefix, number_reset,
    number_start, number_pad, mail_sender_id, domain_id, content`;

/**
 * Le reste dû d'une facture, en SQL. Son jumeau TypeScript est
 * `remainingCents` de `contracts/money.ts` : celui-là sert une fiche, celui-ci
 * sert une somme sur des milliers de lignes. Les deux doivent dire la même
 * chose, et c'est la seule duplication assumée du module.
 */
const CLIENT_COLUMNS = 'id, kind, payment_terms_days, default_vat_bp, archived, content';

/**
 * Les colonnes d'un document, jamais une étoile : sans `DATE_FORMAT`, le pilote
 * rendrait un objet `Date` recalé sur le fuseau du processus, et un jour civil
 * changerait de jour.
 */
const DOC_COLUMNS = `d.id, d.client_id, d.kind, d.parent_doc_id, d.is_deposit, d.status, d.archived, d.seq_year, d.number,
    d.number_label,
    DATE_FORMAT(d.issued_on, '%Y-%m-%d') AS issued_on,
    DATE_FORMAT(d.due_on, '%Y-%m-%d') AS due_on,
    DATE_FORMAT(d.valid_until, '%Y-%m-%d') AS valid_until,
    d.deposit_bp,
    DATE_FORMAT(d.performed_on, '%Y-%m-%d') AS performed_on,
    d.currency, d.vat_regime, d.total_net, d.total_vat, d.total_gross,
    d.public_token, d.accepted_at, d.sent_at, d.reminded_at, d.issuer_snapshot, d.client_snapshot, d.content, d.updated`;

/** Les mêmes, relues depuis la table dérivée qui porte le reste dû. */
const DOC_OUTER = `t.id, t.client_id, t.kind, t.parent_doc_id, t.is_deposit, t.status, t.archived, t.seq_year, t.number,
    t.number_label, t.issued_on, t.due_on, t.valid_until, t.deposit_bp, t.performed_on, t.currency, t.vat_regime,
    t.total_net, t.total_vat, t.total_gross, t.public_token, t.accepted_at, t.sent_at, t.reminded_at, t.issuer_snapshot, t.client_snapshot,
    t.content, t.updated`;

const LINE_COLUMNS = `id, doc_id, sort_order, kind, quantity_milli, unit, unit_price, vat_bp, net_amount, content`;

const REST_EXPRESSION = `GREATEST(
    d.total_gross - COALESCE(p.paid, 0) - COALESCE(c.credited, 0) - COALESCE(x.deducted, 0), 0)`;

const REST_JOINS = `
    LEFT JOIN (SELECT doc_id, SUM(amount) AS paid FROM ft_invoicing_payments
                WHERE workspace_id = ? GROUP BY doc_id) p ON p.doc_id = d.id
    LEFT JOIN (SELECT parent_doc_id, SUM(total_gross) AS credited FROM ft_invoicing_docs
                WHERE workspace_id = ? AND kind = 'credit' AND status = 'issued'
                GROUP BY parent_doc_id) c ON c.parent_doc_id = d.id
    LEFT JOIN (SELECT doc_id, SUM(amount) AS deducted FROM ft_invoicing_deductions
                WHERE workspace_id = ? GROUP BY doc_id) x ON x.doc_id = d.id`;

export function createRepo(q: SdkQueryable): InvoicingRepo {
    return {
        async getSettings(workspaceId) {
            const rows = await q.query<InvoicingSettingsRow>(
                `SELECT ${SETTINGS_COLUMNS} FROM ft_invoicing_settings WHERE workspace_id = ?`,
                [workspaceId]
            );
            return rows[0] ?? null;
        },

        async saveSettings(workspaceId, row, at) {
            // Un seul aller-retour, et rejouable : la ligne naît au premier
            // enregistrement et se remplace aux suivants.
            await q.execute(
                `INSERT INTO ft_invoicing_settings
                    (workspace_id, currency, time_zone, vat_regime, default_vat_bp, payment_terms_days,
                     quote_validity_days, default_deposit_bp, quote_prefix, invoice_prefix, credit_prefix,
                     number_reset, number_start, number_pad, mail_sender_id, domain_id, content, updated)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    currency = VALUES(currency),
                    time_zone = VALUES(time_zone),
                    vat_regime = VALUES(vat_regime),
                    default_vat_bp = VALUES(default_vat_bp),
                    payment_terms_days = VALUES(payment_terms_days),
                    quote_validity_days = VALUES(quote_validity_days),
                    default_deposit_bp = VALUES(default_deposit_bp),
                    quote_prefix = VALUES(quote_prefix),
                    invoice_prefix = VALUES(invoice_prefix),
                    credit_prefix = VALUES(credit_prefix),
                    number_reset = VALUES(number_reset),
                    number_start = VALUES(number_start),
                    number_pad = VALUES(number_pad),
                    mail_sender_id = VALUES(mail_sender_id),
                    domain_id = VALUES(domain_id),
                    content = VALUES(content),
                    updated = VALUES(updated)`,
                [
                    workspaceId,
                    row.currency,
                    row.time_zone,
                    row.vat_regime,
                    row.default_vat_bp,
                    row.payment_terms_days,
                    row.quote_validity_days,
                    row.default_deposit_bp,
                    row.quote_prefix,
                    row.invoice_prefix,
                    row.credit_prefix,
                    row.number_reset,
                    row.number_start,
                    row.number_pad,
                    row.mail_sender_id,
                    row.domain_id,
                    row.content,
                    at
                ]
            );
        },

        async clearDomain(domainId, workspaceId) {
            await q.execute(
                'UPDATE ft_invoicing_settings SET domain_id = NULL WHERE workspace_id = ? AND domain_id = ?',
                [workspaceId, domainId]
            );
        },

        async outstanding(workspaceId, today) {
            const rows = await q.query<{ outstanding: string | number; overdue: string | number; late: number }>(
                `SELECT COALESCE(SUM(t.rest), 0) AS outstanding,
                        COALESCE(SUM(CASE WHEN t.overdue THEN t.rest ELSE 0 END), 0) AS overdue,
                        COALESCE(SUM(CASE WHEN t.overdue AND t.rest > 0 THEN 1 ELSE 0 END), 0) AS late
                   FROM (
                        SELECT ${REST_EXPRESSION} AS rest,
                               (d.due_on IS NOT NULL AND d.due_on < ?) AS overdue
                          FROM ft_invoicing_docs d ${REST_JOINS}
                         WHERE d.workspace_id = ? AND d.kind = 'invoice' AND d.status = 'issued'
                   ) t`,
                [today, workspaceId, workspaceId, workspaceId, workspaceId]
            );
            const row = rows[0];
            return {
                outstandingCents: Number(row?.outstanding ?? 0),
                overdueCents: Number(row?.overdue ?? 0),
                overdueCount: Number(row?.late ?? 0)
            };
        },

        async toBill(workspaceId) {
            const rows = await q.query<{ cents: string | number; n: number }>(
                `SELECT COALESCE(SUM(q.total_gross), 0) AS cents, COUNT(*) AS n
                   FROM ft_invoicing_docs q
                  WHERE q.workspace_id = ? AND q.kind = 'quote' AND q.status = 'accepted'
                    AND NOT EXISTS (
                        SELECT 1 FROM ft_invoicing_docs i
                         WHERE i.parent_doc_id = q.id AND i.kind = 'invoice' AND i.status <> 'draft'
                    )`,
                [workspaceId]
            );
            const row = rows[0];
            return { cents: Number(row?.cents ?? 0), count: Number(row?.n ?? 0) };
        },

        async countDrafts(workspaceId) {
            const rows = await q.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM ft_invoicing_docs WHERE workspace_id = ? AND status = 'draft'`,
                [workspaceId]
            );
            return Number(rows[0]?.n ?? 0);
        },

        async countIssuedSince(workspaceIds, from, kind) {
            if (workspaceIds.length === 0) return 0;
            const holes = workspaceIds.map(() => '?').join(', ');
            const rows = await q.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM ft_invoicing_docs
                  WHERE workspace_id IN (${holes}) AND kind = ?
                    AND status <> 'draft' AND issued_on >= ?`,
                [...workspaceIds, kind, from]
            );
            return Number(rows[0]?.n ?? 0);
        },

        async listClients(workspaceId, includeArchived) {
            return q.query<InvoicingClientRow>(
                `SELECT ${CLIENT_COLUMNS} FROM ft_invoicing_clients
                  WHERE workspace_id = ?${includeArchived ? '' : ' AND archived = 0'}
                  ORDER BY id DESC LIMIT 500`,
                [workspaceId]
            );
        },

        async findClient(id, workspaceId) {
            const rows = await q.query<InvoicingClientRow>(
                `SELECT ${CLIENT_COLUMNS} FROM ft_invoicing_clients WHERE id = ? AND workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },

        async clientUsage(workspaceId, today) {
            type CountRow = {
                client_id: number;
                documents: number;
                billed: string | number;
                last_issued: string | null;
            };
            type RestRow = { client_id: number; outstanding: string | number; overdue: string | number };

            const [counts, rests] = await Promise.all([
                q.query<CountRow>(
                    `SELECT d.client_id,
                            COUNT(*) AS documents,
                            GREATEST(COALESCE(SUM(CASE
                                WHEN d.kind = 'invoice' AND d.status = 'issued' THEN d.total_gross
                                WHEN d.kind = 'credit' AND d.status = 'issued' THEN -d.total_gross
                                ELSE 0 END), 0), 0) AS billed,
                            DATE_FORMAT(MAX(CASE WHEN d.status <> 'draft' THEN d.issued_on END), '%Y-%m-%d')
                                AS last_issued
                       FROM ft_invoicing_docs d
                      WHERE d.workspace_id = ? AND d.client_id IS NOT NULL
                      GROUP BY d.client_id`,
                    [workspaceId]
                ),
                q.query<RestRow>(
                    `SELECT t.client_id,
                            COALESCE(SUM(t.rest), 0) AS outstanding,
                            COALESCE(SUM(CASE WHEN t.overdue THEN t.rest ELSE 0 END), 0) AS overdue
                       FROM (
                            SELECT d.client_id AS client_id,
                                   ${REST_EXPRESSION} AS rest,
                                   (d.due_on IS NOT NULL AND d.due_on < ?) AS overdue
                              FROM ft_invoicing_docs d ${REST_JOINS}
                             WHERE d.workspace_id = ? AND d.kind = 'invoice'
                               AND d.status = 'issued' AND d.client_id IS NOT NULL
                       ) t
                      GROUP BY t.client_id`,
                    [today, workspaceId, workspaceId, workspaceId, workspaceId]
                )
            ]);

            const usage = new Map<number, InvoicingClientUsage>();
            for (const row of counts) {
                usage.set(row.client_id, {
                    documents: Number(row.documents),
                    billedCents: Number(row.billed),
                    outstandingCents: 0,
                    overdueCents: 0,
                    lastIssuedOn: row.last_issued
                });
            }
            for (const row of rests) {
                const entry = usage.get(row.client_id);
                if (!entry) continue;
                entry.outstandingCents = Number(row.outstanding);
                entry.overdueCents = Number(row.overdue);
            }
            return usage;
        },

        async insertClient(workspaceId, row, at) {
            const res = await q.execute(
                `INSERT INTO ft_invoicing_clients
                    (workspace_id, kind, payment_terms_days, default_vat_bp, archived, created, updated, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [workspaceId, row.kind, row.payment_terms_days, row.default_vat_bp, row.archived, at, at, row.content]
            );
            return res.insertId;
        },

        async updateClient(id, workspaceId, row, at) {
            const res = await q.execute(
                `UPDATE ft_invoicing_clients
                    SET kind = ?, payment_terms_days = ?, default_vat_bp = ?, archived = ?, updated = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [row.kind, row.payment_terms_days, row.default_vat_bp, row.archived, at, row.content, id, workspaceId]
            );
            return res.affectedRows;
        },

        async deleteClient(id, workspaceId) {
            const res = await q.execute(`DELETE FROM ft_invoicing_clients WHERE id = ? AND workspace_id = ?`, [
                id,
                workspaceId
            ]);
            return res.affectedRows;
        },

        async listDocs(workspaceId, filter, today) {
            const where: string[] = ['d.workspace_id = ?'];
            const params: unknown[] = [workspaceId, workspaceId, workspaceId, workspaceId];
            if (filter.archived !== null) {
                where.push('d.archived = ?');
                params.push(filter.archived ? 1 : 0);
            }
            if (filter.kind !== null) {
                where.push('d.kind = ?');
                params.push(filter.kind);
            }
            if (filter.status !== null) {
                where.push('d.status = ?');
                params.push(filter.status);
            }
            if (filter.clientId !== null) {
                where.push('d.client_id = ?');
                params.push(filter.clientId);
            }
            if (filter.year !== null) {
                // `YEAR` sur une colonne DATE ignore tout fuseau. Un brouillon
                // n'a pas de date d'émission : filtrer par année, c'est
                // interroger ce qui est sorti.
                where.push('d.issued_on IS NOT NULL AND YEAR(d.issued_on) = ?');
                params.push(filter.year);
            }
            if (filter.search.length > 0) {
                // Seul le numéro se cherche en SQL : tout le reste est scellé.
                where.push('d.number_label LIKE ?');
                params.push(`%${filter.search}%`);
            }

            const inner = `SELECT ${DOC_COLUMNS}, ${REST_EXPRESSION} AS rest
                             FROM ft_invoicing_docs d ${REST_JOINS}
                            WHERE ${where.join(' AND ')}`;

            const outer: string[] = [];
            const derivedParams: unknown[] = [];
            if (filter.derived === 'overdue') {
                outer.push(`t.kind = 'invoice' AND t.status = 'issued' AND t.due_on < ? AND t.rest > 0`);
                derivedParams.push(today);
            } else if (filter.derived === 'unpaid') {
                outer.push(`t.kind = 'invoice' AND t.status = 'issued' AND t.rest > 0`);
            } else if (filter.derived === 'expired') {
                outer.push(`t.kind = 'quote' AND t.status = 'sent' AND t.valid_until < ?`);
                derivedParams.push(today);
            }
            const having = outer.length > 0 ? `WHERE ${outer.join(' AND ')}` : '';

            const [rows, totals] = await Promise.all([
                q.query<InvoicingDocRow>(
                    `SELECT ${DOC_OUTER} FROM (${inner}) t ${having}
                      ORDER BY COALESCE(t.issued_on, '9999-12-31') DESC, t.id DESC
                      LIMIT ? OFFSET ?`,
                    [...params, ...derivedParams, filter.limit, filter.offset]
                ),
                q.query<{ n: number; outstanding: string | number; overdue: string | number }>(
                    `SELECT COUNT(*) AS n,
                            COALESCE(SUM(CASE WHEN t.kind = 'invoice' AND t.status = 'issued'
                                              THEN t.rest ELSE 0 END), 0) AS outstanding,
                            COALESCE(SUM(CASE WHEN t.kind = 'invoice' AND t.status = 'issued'
                                               AND t.due_on IS NOT NULL AND t.due_on < ?
                                              THEN t.rest ELSE 0 END), 0) AS overdue
                       FROM (${inner}) t ${having}`,
                    [today, ...params, ...derivedParams]
                )
            ]);

            const row = totals[0];
            return {
                rows,
                count: Number(row?.n ?? 0),
                outstandingCents: Number(row?.outstanding ?? 0),
                overdueCents: Number(row?.overdue ?? 0)
            };
        },

        async findDoc(id, workspaceId) {
            const rows = await q.query<InvoicingDocRow>(
                `SELECT ${DOC_COLUMNS} FROM ft_invoicing_docs d WHERE d.id = ? AND d.workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },

        async insertDoc(workspaceId, row, at) {
            const res = await q.execute(
                `INSERT INTO ft_invoicing_docs
                    (workspace_id, client_id, kind, parent_doc_id, is_deposit, status, currency, vat_regime,
                     due_on, valid_until, deposit_bp, performed_on, content, created_by, created, updated)
                 VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    row.client_id,
                    row.kind,
                    row.parent_doc_id,
                    row.is_deposit,
                    row.currency,
                    row.vat_regime,
                    row.due_on,
                    row.valid_until,
                    row.deposit_bp,
                    row.performed_on,
                    row.content,
                    row.created_by,
                    at,
                    at
                ]
            );
            return res.insertId;
        },

        async updateDocDraft(id, workspaceId, patch, at) {
            const res = await q.execute(
                `UPDATE ft_invoicing_docs
                    SET client_id = ?, due_on = ?, valid_until = ?, deposit_bp = ?, performed_on = ?, content = ?,
                        updated = ?
                  WHERE id = ? AND workspace_id = ? AND status = 'draft'`,
                [
                    patch.client_id,
                    patch.due_on,
                    patch.valid_until,
                    patch.deposit_bp,
                    patch.performed_on,
                    patch.content,
                    at,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows;
        },

        async deleteDoc(id, workspaceId) {
            // Un brouillon déjà numéroté est un document dont l'émission s'est
            // interrompue : le supprimer ouvrirait un trou dans la suite.
            const res = await q.execute(
                `DELETE FROM ft_invoicing_docs
                  WHERE id = ? AND workspace_id = ? AND status = 'draft' AND number IS NULL`,
                [id, workspaceId]
            );
            return res.affectedRows;
        },

        async setArchived(id, workspaceId, archived, at) {
            const res = await q.execute(
                `UPDATE ft_invoicing_docs SET archived = ?, updated = ?
                  WHERE id = ? AND workspace_id = ? AND status <> 'draft'`,
                [archived ? 1 : 0, at, id, workspaceId]
            );
            return res.affectedRows;
        },

        async listLines(docIds, workspaceId) {
            if (docIds.length === 0) return [];
            const holes = docIds.map(() => '?').join(', ');
            return q.query<InvoicingLineRow>(
                `SELECT ${LINE_COLUMNS} FROM ft_invoicing_lines
                  WHERE workspace_id = ? AND doc_id IN (${holes})
                  ORDER BY doc_id, sort_order, id`,
                [workspaceId, ...docIds]
            );
        },

        async setLines(docId, workspaceId, lines) {
            const kept = lines.filter((line) => line.id !== null).map((line) => line.id as number);
            // Un vidage suivi d'un remplissage perdrait tout si le serveur
            // s'arrêtait entre les deux : sans transaction, on ne retire que ce
            // qui a disparu de la saisie.
            const holes = kept.length > 0 ? kept.map(() => '?').join(', ') : 'NULL';
            await q.execute(
                `DELETE l FROM ft_invoicing_lines l
                   JOIN ft_invoicing_docs d ON d.id = l.doc_id
                  WHERE l.doc_id = ? AND l.workspace_id = ? AND d.status = 'draft'
                    AND l.id NOT IN (${holes})`,
                [docId, workspaceId, ...kept]
            );

            for (const line of lines) {
                if (line.id === null) {
                    // L'état du document est dans la même instruction : une
                    // émission concurrente ne peut pas se voir ajouter de ligne.
                    await q.execute(
                        `INSERT INTO ft_invoicing_lines
                            (doc_id, workspace_id, sort_order, kind, quantity_milli, unit, unit_price, vat_bp, content)
                         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
                           FROM ft_invoicing_docs d
                          WHERE d.id = ? AND d.workspace_id = ? AND d.status = 'draft'`,
                        [
                            docId,
                            workspaceId,
                            line.sort_order,
                            line.kind,
                            line.quantity_milli,
                            line.unit,
                            line.unit_price,
                            line.vat_bp,
                            line.content,
                            docId,
                            workspaceId
                        ]
                    );
                } else {
                    await q.execute(
                        `UPDATE ft_invoicing_lines l
                           JOIN ft_invoicing_docs d ON d.id = l.doc_id
                            SET l.sort_order = ?, l.kind = ?, l.quantity_milli = ?, l.unit = ?,
                                l.unit_price = ?, l.vat_bp = ?, l.content = ?
                          WHERE l.id = ? AND l.doc_id = ? AND l.workspace_id = ? AND d.status = 'draft'`,
                        [
                            line.sort_order,
                            line.kind,
                            line.quantity_milli,
                            line.unit,
                            line.unit_price,
                            line.vat_bp,
                            line.content,
                            line.id,
                            docId,
                            workspaceId
                        ]
                    );
                }
            }
        },

        async settledOf(docIds, workspaceId) {
            const settled = new Map<number, InvoicingSettled>();
            if (docIds.length === 0) return settled;
            const holes = docIds.map(() => '?').join(', ');
            const blank = () => ({ paidCents: 0, creditedCents: 0, deductedCents: 0 });

            const [payments, credits, deductions] = await Promise.all([
                q.query<{ doc_id: number; total: string | number }>(
                    `SELECT doc_id, SUM(amount) AS total FROM ft_invoicing_payments
                      WHERE workspace_id = ? AND doc_id IN (${holes}) GROUP BY doc_id`,
                    [workspaceId, ...docIds]
                ),
                q.query<{ parent_doc_id: number; total: string | number }>(
                    `SELECT parent_doc_id, SUM(total_gross) AS total FROM ft_invoicing_docs
                      WHERE workspace_id = ? AND kind = 'credit' AND status = 'issued'
                        AND parent_doc_id IN (${holes}) GROUP BY parent_doc_id`,
                    [workspaceId, ...docIds]
                ),
                q.query<{ doc_id: number; total: string | number }>(
                    `SELECT doc_id, SUM(amount) AS total FROM ft_invoicing_deductions
                      WHERE workspace_id = ? AND doc_id IN (${holes}) GROUP BY doc_id`,
                    [workspaceId, ...docIds]
                )
            ]);

            for (const row of payments) {
                const entry = settled.get(row.doc_id) ?? blank();
                entry.paidCents = Number(row.total);
                settled.set(row.doc_id, entry);
            }
            for (const row of credits) {
                const entry = settled.get(row.parent_doc_id) ?? blank();
                entry.creditedCents = Number(row.total);
                settled.set(row.parent_doc_id, entry);
            }
            for (const row of deductions) {
                const entry = settled.get(row.doc_id) ?? blank();
                entry.deductedCents = Number(row.total);
                settled.set(row.doc_id, entry);
            }
            return settled;
        },

        async maxNumber(workspaceId, kind, seqYear) {
            const rows = await q.query<{ top: number | null }>(
                `SELECT MAX(number) AS top FROM ft_invoicing_docs
                  WHERE workspace_id = ? AND kind = ? AND seq_year = ?`,
                [workspaceId, kind, seqYear]
            );
            return Number(rows[0]?.top ?? 0);
        },

        async lastIssuedOn(workspaceId, kind, seqYear) {
            const rows = await q.query<{ last: string | null }>(
                `SELECT DATE_FORMAT(MAX(issued_on), '%Y-%m-%d') AS last FROM ft_invoicing_docs
                  WHERE workspace_id = ? AND kind = ? AND seq_year = ? AND issued_on IS NOT NULL`,
                [workspaceId, kind, seqYear]
            );
            return rows[0]?.last ?? null;
        },

        async reserveNumber(id, workspaceId, seqYear, value, label) {
            const res = await q.execute(
                `UPDATE ft_invoicing_docs
                    SET seq_year = ?, number = ?, number_label = ?
                  WHERE id = ? AND workspace_id = ? AND number IS NULL`,
                [seqYear, value, label, id, workspaceId]
            );
            return res.affectedRows;
        },

        async issueDoc(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE ft_invoicing_docs
                    SET status = ?, vat_regime = ?, issued_on = ?, due_on = ?, valid_until = ?, deposit_bp = ?,
                        total_net = ?, total_vat = ?, total_gross = ?,
                        issuer_snapshot = ?, client_snapshot = ?, issued_by = ?, updated = ?
                  WHERE id = ? AND workspace_id = ? AND status = 'draft'`,
                [
                    input.status,
                    input.vat_regime,
                    input.issued_on,
                    input.due_on,
                    input.valid_until,
                    input.deposit_bp,
                    input.total_net,
                    input.total_vat,
                    input.total_gross,
                    input.issuer_snapshot,
                    input.client_snapshot,
                    input.issued_by,
                    input.updated,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows;
        },

        async freezeLines(docId, workspaceId, lines) {
            for (const entry of lines) {
                await q.execute(
                    `UPDATE ft_invoicing_lines SET net_amount = ?, vat_bp = ?
                      WHERE id = ? AND doc_id = ? AND workspace_id = ?`,
                    [entry.net, entry.vatBp, entry.id, docId, workspaceId]
                );
            }
        },

        async setStatus(id, workspaceId, from, to, at) {
            const res = await q.execute(
                `UPDATE ft_invoicing_docs SET status = ?, updated = ?
                  WHERE id = ? AND workspace_id = ? AND status = ?`,
                [to, at, id, workspaceId, from]
            );
            return res.affectedRows;
        },

        async findByToken(token) {
            const rows = await q.query<InvoicingDocRow & { workspace_id: number }>(
                `SELECT ${DOC_COLUMNS}, d.workspace_id FROM ft_invoicing_docs d WHERE d.public_token = ?`,
                [token]
            );
            return rows[0] ?? null;
        },

        async setToken(id, workspaceId, token) {
            const res = await q.execute(
                `UPDATE ft_invoicing_docs SET public_token = ? WHERE id = ? AND workspace_id = ?`,
                [token, id, workspaceId]
            );
            return res.affectedRows;
        },

        async markSent(id, workspaceId, at) {
            const res = await q.execute(`UPDATE ft_invoicing_docs SET sent_at = ? WHERE id = ? AND workspace_id = ?`, [
                at,
                id,
                workspaceId
            ]);
            return res.affectedRows;
        },

        async overdueToRemind(today, staleBefore, limit) {
            return q.query<InvoicingDocRow & { workspace_id: number }>(
                `SELECT ${DOC_OUTER}, t.workspace_id FROM (
                        SELECT ${DOC_COLUMNS}, d.workspace_id, ${REST_EXPRESSION} AS rest
                          FROM ft_invoicing_docs d
                          LEFT JOIN (SELECT doc_id, SUM(amount) AS paid FROM ft_invoicing_payments
                                      GROUP BY doc_id) p ON p.doc_id = d.id
                          LEFT JOIN (SELECT parent_doc_id, SUM(total_gross) AS credited FROM ft_invoicing_docs
                                      WHERE kind = 'credit' AND status = 'issued'
                                      GROUP BY parent_doc_id) c ON c.parent_doc_id = d.id
                          LEFT JOIN (SELECT doc_id, SUM(amount) AS deducted FROM ft_invoicing_deductions
                                      GROUP BY doc_id) x ON x.doc_id = d.id
                         WHERE d.kind = 'invoice' AND d.status = 'issued' AND d.archived = 0 AND d.due_on < ?
                           AND (d.reminded_at IS NULL OR d.reminded_at < ?)
                    ) t
                  WHERE t.rest > 0
                  ORDER BY t.due_on ASC
                  LIMIT ?`,
                [today, staleBefore, limit]
            );
        },

        async markReminded(ids, at) {
            if (ids.length === 0) return;
            const holes = ids.map(() => '?').join(', ');
            await q.execute(`UPDATE ft_invoicing_docs SET reminded_at = ? WHERE id IN (${holes})`, [at, ...ids]);
        },

        async answerQuote(id, token, status, at, content) {
            // La garde EST la requête : un devis déjà accepté, refusé ou pas
            // encore envoyé ne bouge pas. `accepted_at` ne porte que l'accord ; le
            // refus s'horodate dans le scellé, avec le nom de qui a répondu.
            const res = await q.execute(
                `UPDATE ft_invoicing_docs
                    SET status = ?, accepted_at = ?, content = ?, updated = ?
                  WHERE id = ? AND public_token = ? AND kind = 'quote' AND status = 'sent'`,
                [status, status === 'accepted' ? at : null, content, at, id, token]
            );
            return res.affectedRows;
        },

        async depositsOf(quoteId, workspaceId) {
            return q.query<InvoicingDocRow>(
                `SELECT ${DOC_COLUMNS} FROM ft_invoicing_docs d
                  WHERE d.workspace_id = ? AND d.parent_doc_id = ? AND d.kind = 'invoice'
                    AND d.is_deposit = 1 AND d.status = 'issued'
                  ORDER BY d.id`,
                [workspaceId, quoteId]
            );
        },

        async insertDeduction(workspaceId, row, at) {
            // Le même acompte ne se déduit qu'une fois du même solde : l'index
            // unique le tient, et un rejeu ne double donc pas la déduction.
            await q.execute(
                `INSERT INTO ft_invoicing_deductions (doc_id, workspace_id, deducted_doc_id, amount, created)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE amount = VALUES(amount)`,
                [row.doc_id, workspaceId, row.deducted_doc_id, row.amount, at]
            );
        },

        async listDeductions(docId, workspaceId) {
            return q.query<InvoicingDeductionRow>(
                `SELECT deducted_doc_id, amount FROM ft_invoicing_deductions
                  WHERE doc_id = ? AND workspace_id = ? ORDER BY id`,
                [docId, workspaceId]
            );
        },

        async listPayments(docId, workspaceId) {
            return q.query<InvoicingPaymentRow>(
                `SELECT id, doc_id, DATE_FORMAT(paid_on, '%Y-%m-%d') AS paid_on, amount, method, content
                   FROM ft_invoicing_payments
                  WHERE doc_id = ? AND workspace_id = ?
                  ORDER BY paid_on DESC, id DESC`,
                [docId, workspaceId]
            );
        },

        async insertPayment(workspaceId, row, at) {
            const res = await q.execute(
                `INSERT INTO ft_invoicing_payments (doc_id, workspace_id, paid_on, amount, method, content, created)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [row.doc_id, workspaceId, row.paid_on, row.amount, row.method, row.content, at]
            );
            return res.insertId;
        },

        async deletePayment(id, docId, workspaceId) {
            const res = await q.execute(
                `DELETE FROM ft_invoicing_payments WHERE id = ? AND doc_id = ? AND workspace_id = ?`,
                [id, docId, workspaceId]
            );
            return res.affectedRows;
        },

        async cashedBetween(workspaceId, from, to) {
            // La part de taxe se calcule règlement par règlement dans `money.ts`,
            // seul endroit qui arrondit : Finances reprend la même, au centime.
            const rows = await q.query<{
                amount: string | number;
                total_vat: number | null;
                total_gross: number | null;
            }>(
                `SELECT p.amount, d.total_vat, d.total_gross
                   FROM ft_invoicing_payments p
                   JOIN ft_invoicing_docs d ON d.id = p.doc_id
                  WHERE p.workspace_id = ? AND p.paid_on BETWEEN ? AND ?`,
                [workspaceId, from, to]
            );
            let cents = 0;
            let vatCents = 0;
            for (const row of rows) {
                const amount = Number(row.amount);
                cents += amount;
                vatCents += paymentVatCents(amount, Number(row.total_vat ?? 0), Number(row.total_gross ?? 0));
            }
            return { cents, vatCents };
        },

        async ledgerVersion(workspaceId) {
            const rows = await q.query<{ n: number; top: number }>(
                `SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS top
                   FROM ft_invoicing_payments WHERE workspace_id = ?`,
                [workspaceId]
            );
            return `${Number(rows[0]?.n ?? 0)}:${Number(rows[0]?.top ?? 0)}`;
        },

        async ledgerPayments(workspaceId, from) {
            const since = from === null ? '' : 'AND p.paid_on >= ?';
            return q.query<InvoicingLedgerRow>(
                `SELECT p.id, p.doc_id, DATE_FORMAT(p.paid_on, '%Y-%m-%d') AS paid_on, p.amount, p.method,
                        d.number_label, d.currency, d.total_vat, d.total_gross
                   FROM ft_invoicing_payments p
                   JOIN ft_invoicing_docs d ON d.id = p.doc_id AND d.workspace_id = p.workspace_id
                  WHERE p.workspace_id = ? ${since}
                  ORDER BY p.paid_on ASC, p.id ASC`,
                from === null ? [workspaceId] : [workspaceId, from]
            );
        },

        async clientSnapshotsOf(workspaceId, docIds) {
            const snapshots = new Map<number, string>();
            if (docIds.length === 0) return snapshots;
            // Des marqueurs engendrés depuis la longueur du tableau, jamais depuis son contenu.
            const marks = docIds.map(() => '?').join(', ');
            const rows = await q.query<{ id: number; client_snapshot: string | null }>(
                `SELECT id, client_snapshot FROM ft_invoicing_docs
                  WHERE workspace_id = ? AND id IN (${marks})`,
                [workspaceId, ...docIds]
            );
            for (const row of rows) if (row.client_snapshot !== null) snapshots.set(row.id, row.client_snapshot);
            return snapshots;
        },

        async billedBetween(workspaceId, from, to) {
            const rows = await q.query<{
                kind: string;
                net: string | number;
                vat: string | number;
                gross: string | number;
                n: number;
            }>(
                `SELECT kind, COALESCE(SUM(total_net), 0) AS net, COALESCE(SUM(total_vat), 0) AS vat,
                        COALESCE(SUM(total_gross), 0) AS gross, COUNT(*) AS n
                   FROM ft_invoicing_docs
                  WHERE workspace_id = ? AND status = 'issued' AND kind IN ('invoice', 'credit')
                    AND issued_on BETWEEN ? AND ?
                  GROUP BY kind`,
                [workspaceId, from, to]
            );
            const totals = { netCents: 0, vatCents: 0, grossCents: 0, count: 0 };
            for (const row of rows) {
                const sign = row.kind === 'credit' ? -1 : 1;
                totals.netCents += sign * Number(row.net);
                totals.vatCents += sign * Number(row.vat);
                totals.grossCents += sign * Number(row.gross);
                if (row.kind === 'invoice') totals.count += Number(row.n);
            }
            return totals;
        },

        async monthlySeries(workspaceId, from, to) {
            const [billed, cashed] = await Promise.all([
                q.query<{ month: string; total: string | number }>(
                    `SELECT DATE_FORMAT(issued_on, '%Y-%m') AS month,
                            COALESCE(SUM(CASE WHEN kind = 'credit' THEN -total_gross ELSE total_gross END), 0) AS total
                       FROM ft_invoicing_docs
                      WHERE workspace_id = ? AND status = 'issued' AND kind IN ('invoice', 'credit')
                        AND issued_on BETWEEN ? AND ?
                      GROUP BY month`,
                    [workspaceId, from, to]
                ),
                q.query<{ month: string; total: string | number }>(
                    `SELECT DATE_FORMAT(paid_on, '%Y-%m') AS month, COALESCE(SUM(amount), 0) AS total
                       FROM ft_invoicing_payments
                      WHERE workspace_id = ? AND paid_on BETWEEN ? AND ?
                      GROUP BY month`,
                    [workspaceId, from, to]
                )
            ]);

            const months = new Map<string, InvoicingMonth>();
            const at = (month: string) => {
                const entry = months.get(month) ?? { month, billedCents: 0, cashedCents: 0 };
                months.set(month, entry);
                return entry;
            };
            for (const row of billed) at(row.month).billedCents = Math.max(0, Number(row.total));
            for (const row of cashed) at(row.month).cashedCents = Number(row.total);
            return [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
        },

        async quotesPending(workspaceId, today) {
            const rows = await q.query<{ cents: string | number; n: number; expiring: number }>(
                `SELECT COALESCE(SUM(total_gross), 0) AS cents, COUNT(*) AS n,
                        COALESCE(SUM(CASE WHEN valid_until IS NOT NULL
                                           AND valid_until < DATE_ADD(?, INTERVAL 8 DAY)
                                          THEN 1 ELSE 0 END), 0) AS expiring
                   FROM ft_invoicing_docs
                  WHERE workspace_id = ? AND kind = 'quote' AND status = 'sent'
                    AND (valid_until IS NULL OR valid_until >= ?)`,
                [today, workspaceId, today]
            );
            const row = rows[0];
            return {
                cents: Number(row?.cents ?? 0),
                count: Number(row?.n ?? 0),
                expiring: Number(row?.expiring ?? 0)
            };
        },

        async actionable(workspaceId, today, soon, limit) {
            return q.query<InvoicingDocRow>(
                `SELECT ${DOC_OUTER} FROM (
                        SELECT ${DOC_COLUMNS}, ${REST_EXPRESSION} AS rest
                          FROM ft_invoicing_docs d ${REST_JOINS}
                         WHERE d.workspace_id = ? AND d.archived = 0
                    ) t
                  WHERE (t.kind = 'invoice' AND t.status = 'issued' AND t.due_on < ? AND t.rest > 0)
                     OR (t.kind = 'quote' AND t.status = 'sent'
                         AND t.valid_until IS NOT NULL AND t.valid_until >= ? AND t.valid_until < ?)
                     OR (t.kind = 'quote' AND t.status = 'accepted'
                         AND NOT EXISTS (
                             SELECT 1 FROM ft_invoicing_docs i
                              WHERE i.parent_doc_id = t.id AND i.kind = 'invoice' AND i.status <> 'draft'
                         ))
                  ORDER BY COALESCE(t.due_on, t.valid_until, t.issued_on) ASC
                  LIMIT ?`,
                [workspaceId, workspaceId, workspaceId, workspaceId, today, today, soon, limit]
            );
        },

        async numbersOf(ids, workspaceId) {
            const numbers = new Map<number, string>();
            if (ids.length === 0) return numbers;
            const holes = ids.map(() => '?').join(', ');
            const rows = await q.query<{ id: number; number_label: string | null }>(
                `SELECT id, number_label FROM ft_invoicing_docs
                  WHERE workspace_id = ? AND id IN (${holes})`,
                [workspaceId, ...ids]
            );
            for (const row of rows) if (row.number_label !== null) numbers.set(row.id, row.number_label);
            return numbers;
        },

        async countDocsOfClient(id, workspaceId) {
            const rows = await q.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM ft_invoicing_docs WHERE client_id = ? AND workspace_id = ?`,
                [id, workspaceId]
            );
            return Number(rows[0]?.n ?? 0);
        }
    };
}
