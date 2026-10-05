import type {
    FinanceAccountBalanceRow,
    FinanceAccountKind,
    FinanceAccountRow,
    FinanceCategoryRole,
    FinanceCategoryRow,
    FinanceColor,
    FinanceConfigRow,
    FinanceFlow,
    FinanceFrequency,
    FinanceRecurringRow,
    FinanceTransactionKind,
    FinanceTransactionRow
} from '../contracts/domain';
import type { SdkQueryable, SdkStockItem } from '@deveye/types/sdk/server';

import type {
    BankConnectionStatus,
    BankProvider,
    FinanceBankLinkRow,
    FinanceConnectionRow
} from '../contracts/banking';

import type { FinanceRuleRow, FinanceStatementLineRow, StatementDirection } from '../contracts/statement';

/**
 * Aucun `SELECT *` sur une table à colonne `DATE` : le pilote rendrait un
 * objet `Date` recalé sur le fuseau du processus, d'où les projections
 * `DATE_FORMAT(..., '%Y-%m-%d')`. Chaque requête filtre sur `workspace_id`,
 * même par identifiant.
 */

/** Colonnes d'une opération, la date projetée en `AAAA-MM-JJ`. */
const TX_COLUMNS = `t.id, t.workspace_id, t.account_id, t.transfer_account_id, t.category_id,
    t.recurring_id, t.source, t.source_ref, t.kind, t.amount, t.vat_amount,
    DATE_FORMAT(t.date, '%Y-%m-%d') AS date, t.cleared, t.content, t.created, t.updated`;

/** Colonnes d'un compte, le jour de départ projeté en `AAAA-MM-JJ`. */
const ACCOUNT_COLUMNS = `a.id, a.workspace_id, a.kind, a.color, a.initial_balance,
    DATE_FORMAT(a.opened_on, '%Y-%m-%d') AS opened_on, a.archived, a.sort_order, a.content, a.created`;

/** Colonnes d'une échéance, les trois dates projetées. */
const REC_COLUMNS = `r.id, r.workspace_id, r.account_id, r.transfer_account_id, r.category_id,
    r.kind, r.amount, r.vat_amount, r.frequency, r.interval_count,
    DATE_FORMAT(r.next_date, '%Y-%m-%d') AS next_date,
    r.anchor_day,
    DATE_FORMAT(r.end_date, '%Y-%m-%d') AS end_date,
    DATE_FORMAT(r.last_posted_date, '%Y-%m-%d') AS last_posted_date,
    r.automatic, r.active, r.content, r.created`;

/**
 * Les mouvements vus depuis le compte qu'ils touchent : un virement apparaît
 * deux fois, une par côté, ce qui permet les trois soldes en une agrégation.
 */
const MOVEMENTS = `
    SELECT account_id AS acc, date, cleared,
           CASE kind WHEN 'income' THEN amount ELSE -amount END AS delta
      FROM finance_transactions
     WHERE workspace_id = ?
    UNION ALL
    SELECT transfer_account_id AS acc, date, cleared, amount AS delta
      FROM finance_transactions
     WHERE workspace_id = ? AND kind = 'transfer' AND transfer_account_id IS NOT NULL`;

export interface FinanceAccountInput {
    kind: FinanceAccountKind;
    color: FinanceColor;
    initialBalance: number;
    openedOn: string;
    archived: boolean;
    content: string;
}

export interface FinanceCategoryInput {
    flow: FinanceFlow;
    color: FinanceColor;
    icon: string;
    role: FinanceCategoryRole | null;
    content: string;
}

/** Le statut tel que la ligne de réglages le porte. */
export interface FinanceStatusInput {
    legalStatus: string | null;
    microActivity: string | null;
    provisionRateBp: number | null;
    incomeTaxPrepaid: boolean;
    declarationPeriod: string | null;
    trackingSince: string | null;
}

/** Une ligne de relevé à écrire, déjà chiffrée, son identité chez la banque calculée. */
export interface FinanceStatementLineInput {
    accountId: number;
    /** `null` pour une ligne venue d'une connexion : elle n'appartient à aucun fichier. */
    importId: number | null;
    externalId: string;
    date: string;
    direction: StatementDirection;
    amount: number;
    content: string;
}

export interface FinanceImportInput {
    accountId: number;
    format: string;
    firstDate: string | null;
    lastDate: string | null;
    lineCount: number;
    newCount: number;
    closingBalance: number | null;
    closingDate: string | null;
}

export interface FinanceRuleInput {
    direction: StatementDirection | null;
    categoryId: number;
    vatRateBp: number | null;
    content: string;
}

/** Un espace en micro-entreprise, tel que le service des rappels le parcourt. */
export interface FinanceDeclaringRow {
    workspace_id: number;
    micro_activity: string;
    declaration_period: string;
    provision_rate_bp: number | null;
    income_tax_prepaid: number;
}

export interface FinanceTransactionInput {
    accountId: number;
    transferAccountId: number | null;
    categoryId: number | null;
    recurringId: number | null;
    /** La provenance d'une copie (`'invoicing'`) et l'identifiant de l'original, ou `null` pour une saisie. */
    source: string | null;
    sourceRef: string | null;
    kind: FinanceTransactionKind;
    amount: number;
    vatAmount: number | null;
    date: string;
    cleared: boolean;
    content: string;
}

/** Une copie telle que la recopie la compare à son original. */
export interface FinanceSourcedRow {
    id: number;
    account_id: number;
    source_ref: string;
    amount: number;
    vat_amount: number | null;
    date: string;
}

export interface FinanceRecurringInput {
    accountId: number;
    transferAccountId: number | null;
    categoryId: number | null;
    kind: FinanceTransactionKind;
    amount: number;
    vatAmount: number | null;
    frequency: FinanceFrequency;
    interval: number;
    nextDate: string;
    /** Jour d'ancrage, dérivé de `nextDate` par l'appelant. */
    anchorDay: number | null;
    endDate: string | null;
    automatic: boolean;
    active: boolean;
    content: string;
}

/** Filtre du journal. Toutes les bornes sont facultatives et se combinent. */
export interface FinanceTransactionFilter {
    accountId?: number;
    categoryId?: number;
    kind?: FinanceTransactionKind;
    /** Premier jour compris. */
    from?: string;
    /** Dernier jour compris. */
    to?: string;
    cleared?: boolean;
}

/** Une part de la répartition par catégorie, telle que l'agrégation la rend. */
export interface FinanceCategoryShareRow {
    category_id: number | null;
    flow: FinanceFlow;
    amount: number;
    count: number;
}

/** Un mois d'entrées et de sorties. */
export interface FinanceMonthRow {
    month: string;
    income: number;
    expense: number;
}

export interface FinanceRepo {
    getConfig(workspaceId: number): Promise<FinanceConfigRow | null>;
    /** Pose le lien avec Facturation et oublie la dernière recopie : la suivante compare tout. */
    setInvoicingLink(workspaceId: number, accountId: number | null, categoryId: number | null): Promise<void>;
    setInvoicingVersion(workspaceId: number, version: string): Promise<void>;
    setStatus(workspaceId: number, status: FinanceStatusInput): Promise<void>;
    /** Tous espaces confondus : ceux qu'une déclaration URSSAF attend. */
    listDeclaring(): Promise<FinanceDeclaringRow[]>;
    /** Retient un rappel ; `false` s'il était déjà parti. */
    markReminder(workspaceId: number, periodKey: string, stage: string): Promise<boolean>;

    /**
     * `includeArchived` ne joue que sur la liste, jamais sur les totaux.
     * `today` est passé et non lu par `CURDATE()` : le fuseau de MySQL et celui
     * de Node peuvent différer.
     */
    listAccounts(workspaceId: number, includeArchived: boolean, today: string): Promise<FinanceAccountBalanceRow[]>;
    findAccount(id: number, workspaceId: number, today: string): Promise<FinanceAccountBalanceRow | null>;
    /** Sans les soldes : une lecture par clé, là où {@link findAccount} déroule l'agrégation de tous les mouvements. */
    findAccountPlain(id: number, workspaceId: number): Promise<FinanceAccountRow | null>;
    createAccount(workspaceId: number, input: FinanceAccountInput): Promise<number>;
    updateAccount(id: number, workspaceId: number, input: FinanceAccountInput): Promise<boolean>;
    deleteAccount(id: number, workspaceId: number): Promise<boolean>;
    reorderAccounts(workspaceId: number, accountIds: number[]): Promise<void>;
    /** Combien d'opérations touchent ce compte, des deux côtés d'un virement. */
    countAccountUsage(id: number, workspaceId: number): Promise<number>;
    /** La clé étrangère est en CASCADE : sans ce décompte, supprimer un compte emporterait ses échéances en silence. */
    countAccountRecurring(id: number, workspaceId: number): Promise<number>;

    listCategories(workspaceId: number): Promise<FinanceCategoryRow[]>;
    findCategory(id: number, workspaceId: number): Promise<FinanceCategoryRow | null>;
    createCategory(workspaceId: number, input: FinanceCategoryInput): Promise<number>;
    updateCategory(id: number, workspaceId: number, input: FinanceCategoryInput): Promise<boolean>;
    deleteCategory(id: number, workspaceId: number): Promise<boolean>;

    listTransactions(
        workspaceId: number,
        filter: FinanceTransactionFilter,
        limit: number,
        offset: number
    ): Promise<FinanceTransactionRow[]>;
    countTransactions(workspaceId: number, filter: FinanceTransactionFilter): Promise<number>;
    /** Sommes des entrées et des sorties du filtre, virements exclus. */
    sumTransactions(
        workspaceId: number,
        filter: FinanceTransactionFilter
    ): Promise<{ income: number; expense: number }>;
    findTransaction(id: number, workspaceId: number): Promise<FinanceTransactionRow | null>;
    /** L'occurrence d'une échéance à une date, servie par l'index unique `(recurring_id, date)`. */
    findOccurrence(workspaceId: number, recurringId: number, date: string): Promise<FinanceTransactionRow | null>;
    createTransaction(workspaceId: number, input: FinanceTransactionInput): Promise<number>;
    updateTransaction(id: number, workspaceId: number, input: FinanceTransactionInput): Promise<boolean>;
    deleteTransaction(id: number, workspaceId: number): Promise<boolean>;
    setCleared(workspaceId: number, ids: number[], cleared: boolean): Promise<void>;
    /** Les copies d'une provenance, pour les comparer à leurs originaux. */
    listSourced(workspaceId: number, source: string): Promise<FinanceSourcedRow[]>;
    /** Aligne les faits d'une copie sur son original : rien d'autre ne bouge. */
    updateSourcedFacts(
        id: number,
        workspaceId: number,
        facts: { amount: number; vatAmount: number | null; date: string }
    ): Promise<void>;
    /** Les recettes saisies à la main sur ce compte, à ce montant, sur `[from, to]` : ni copie ni échéance. */
    listAdoptable(
        workspaceId: number,
        accountId: number,
        amount: number,
        from: string,
        to: string
    ): Promise<FinanceTransactionRow[]>;
    /** Fait d'une saisie la copie d'un original, son contenu réécrit pour dire d'où elle vient. */
    adopt(id: number, workspaceId: number, source: string, sourceRef: string, content: string): Promise<void>;

    /**
     * Somme des soldes à `today`, archivés compris (archiver ne fait pas
     * disparaître l'argent). `today` en paramètre : le fuseau reste celui du
     * serveur, et la courbe demande un solde à une date passée.
     */
    totalBalance(workspaceId: number, today: string, kinds?: FinanceAccountKind[]): Promise<number>;
    /** La même, en tenant compte des opérations déjà datées plus tard. */
    projectedBalance(workspaceId: number): Promise<number>;
    /** Répartition par catégorie sur `[from, to]`, virements exclus. */
    categoryShares(workspaceId: number, from: string, to: string): Promise<FinanceCategoryShareRow[]>;
    /** Entrées et sorties par mois civil sur `[from, to]`, virements exclus. */
    monthlyFlow(workspaceId: number, from: string, to: string): Promise<FinanceMonthRow[]>;
    /** TVA collectée et déductible sur `[from, to]`. */
    vatTotals(workspaceId: number, from: string, to: string): Promise<{ collected: number; deductible: number }>;
    /** Le chiffre d'affaires hors TVA sur `[from, to]` : les recettes, sauf celles rangées hors chiffre d'affaires. */
    revenueBetween(workspaceId: number, from: string, to: string): Promise<number>;
    /** Les charges hors TVA sur `[from, to]` : les dépenses qui ne versent ni cotisations, ni impôts, ni TVA. */
    chargesBetween(workspaceId: number, from: string, to: string): Promise<number>;
    /** Ce qui a été versé sur `[from, to]` dans les catégories de ces rôles. */
    paidByRoles(workspaceId: number, roles: FinanceCategoryRole[], from: string, to: string): Promise<number>;

    listRecurring(workspaceId: number): Promise<FinanceRecurringRow[]>;
    /** Les échéances actives dont l'occurrence est due au plus tard à `onOrBefore`. */
    listDueRecurring(workspaceId: number, onOrBefore: string, automatic?: boolean): Promise<FinanceRecurringRow[]>;
    findRecurring(id: number, workspaceId: number): Promise<FinanceRecurringRow | null>;
    createRecurring(workspaceId: number, input: FinanceRecurringInput): Promise<number>;
    updateRecurring(id: number, workspaceId: number, input: FinanceRecurringInput): Promise<boolean>;
    deleteRecurring(id: number, workspaceId: number): Promise<boolean>;
    /** `lastPostedDate` et `active` à `null` laissent la valeur en place. */
    advanceRecurring(
        id: number,
        workspaceId: number,
        nextDate: string,
        lastPostedDate: string | null,
        active: boolean | null
    ): Promise<void>;

    createImport(workspaceId: number, input: FinanceImportInput): Promise<number>;
    setImportCounts(id: number, workspaceId: number, lineCount: number, newCount: number): Promise<void>;
    /** Le dernier solde annoncé par la banque, par compte. */
    latestClosings(
        workspaceId: number
    ): Promise<{ account_id: number; closing_balance: number; closing_date: string }[]>;
    /** `null` quand la banque avait déjà donné cette ligne : l'index unique `(account_id, external_id)` la refuse. */
    insertLine(workspaceId: number, input: FinanceStatementLineInput): Promise<number | null>;
    findLines(workspaceId: number, ids: readonly number[]): Promise<FinanceStatementLineRow[]>;
    /** Les lignes, celles à rapprocher d'abord puis les plus récentes. */
    listLines(
        workspaceId: number,
        filter: { pendingOnly: boolean; accountId?: number },
        limit: number
    ): Promise<FinanceStatementLineRow[]>;
    countPendingLines(workspaceId: number, accountId?: number): Promise<number>;
    /** `transactionId` à `null` défait le rapprochement. */
    linkLine(id: number, workspaceId: number, transactionId: number | null): Promise<void>;
    setLineIgnored(ids: readonly number[], workspaceId: number, ignored: boolean): Promise<void>;
    /** Les opérations qui touchent ce compte sur `[from, to]` et qu'aucune de ses lignes ne confirme encore. */
    unconfirmedTransactions(
        workspaceId: number,
        accountId: number,
        from: string,
        to: string
    ): Promise<FinanceTransactionRow[]>;
    /** Les lignes qui confirment cette opération : une, deux pour un virement entre deux comptes importés. */
    linkedLines(workspaceId: number, transactionId: number): Promise<FinanceStatementLineRow[]>;
    /** Avant de supprimer une opération : les lignes qui la confirmaient sont écartées, pas remises à rapprocher. */
    releaseLines(transactionId: number, workspaceId: number): Promise<void>;
    countAccountLines(id: number, workspaceId: number): Promise<number>;

    listRules(workspaceId: number): Promise<FinanceRuleRow[]>;
    findRule(id: number, workspaceId: number): Promise<FinanceRuleRow | null>;
    createRule(workspaceId: number, input: FinanceRuleInput): Promise<number>;
    updateRule(id: number, workspaceId: number, input: FinanceRuleInput): Promise<boolean>;
    deleteRule(id: number, workspaceId: number): Promise<boolean>;
    bumpRuleHits(id: number, workspaceId: number, by: number): Promise<void>;

    listConnections(workspaceId: number): Promise<FinanceConnectionRow[]>;
    findConnection(id: number, workspaceId: number): Promise<FinanceConnectionRow | null>;
    createConnection(
        workspaceId: number,
        input: { provider: BankProvider; validUntil: number | null; content: string }
    ): Promise<number>;
    /** Le nom seul : l'état de la dernière relève reste vrai. */
    setConnectionContent(id: number, workspaceId: number, content: string): Promise<boolean>;
    /** Accès neufs (édition, reconnexion) : l'état d'erreur ne leur survit pas. */
    replaceConnection(
        id: number,
        workspaceId: number,
        input: { validUntil: number | null; content: string }
    ): Promise<boolean>;
    recordSync(
        id: number,
        workspaceId: number,
        at: number,
        status: BankConnectionStatus,
        error: string | null
    ): Promise<void>;
    deleteConnection(id: number, workspaceId: number): Promise<boolean>;
    countConnectionsInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
    /** Ce que compte `countConnectionsInWorkspaces`, du plus ancien au plus récent : le stock du quota `bankConnections`. */
    listStockConnections(workspaceIds: readonly number[]): Promise<SdkStockItem[]>;
    /** Toute l'instance : les connexions d'un fournisseur, et celles dont la dernière relève a échoué ou expiré. */
    countProviderConnections(provider: BankProvider): Promise<{ total: number; failing: number }>;
    /**
     * Les connexions à relever, tous espaces : relevées avant `before` ou jamais,
     * hors celles expirées et hors `pausedIds`, écartées dans le SQL pour ne pas
     * affamer les autres derrière le `LIMIT`.
     */
    listDueConnections(before: number, pausedIds: readonly number[], limit: number): Promise<FinanceConnectionRow[]>;
    /** Les consentements qui finissent avant `before`, tous espaces, hors ceux déjà dits expirés. */
    listExpiringConnections(before: number): Promise<FinanceConnectionRow[]>;
    /** Réserve l'avis d'expiration de ce consentement : `false` s'il est déjà parti, d'ici ou d'une autre instance. */
    claimExpiryWarning(id: number, workspaceId: number): Promise<boolean>;
    /** `false` quand elle l'était déjà. */
    markExpired(id: number, workspaceId: number): Promise<boolean>;

    listBankLinks(workspaceId: number): Promise<FinanceBankLinkRow[]>;
    listConnectionLinks(connectionId: number, workspaceId: number): Promise<FinanceBankLinkRow[]>;
    /** `null` délie. Un compte de la banque déjà relié ailleurs lève `ER_DUP_ENTRY`. */
    setBankLink(
        accountId: number,
        workspaceId: number,
        link: { connectionId: number; externalAccountId: string; since: string } | null
    ): Promise<void>;
    /** Le jour de la plus récente ligne de relevé du compte, importée ou relevée. */
    latestLineDate(accountId: number, workspaceId: number): Promise<string | null>;
}

const CONNECTION_COLUMNS = `id, workspace_id, provider, status, error, valid_until, warned_until, last_sync_at,
    content, created`;

const LINK_COLUMNS = `account_id, workspace_id, connection_id, external_account_id,
    DATE_FORMAT(since, '%Y-%m-%d') AS since`;

/** Colonnes d'une ligne de relevé, la date projetée. */
const LINE_COLUMNS = `l.id, l.workspace_id, l.account_id, l.import_id, l.external_id,
    DATE_FORMAT(l.date, '%Y-%m-%d') AS date, l.direction, l.amount, l.transaction_id, l.ignored, l.content`;

function isDuplicateEntry(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === 'ER_DUP_ENTRY';
}

/** Les fragments sont écrits ici, jamais bâtis depuis une donnée reçue : seules les valeurs voyagent. */
function whereOf(workspaceId: number, f: FinanceTransactionFilter): { sql: string; params: unknown[] } {
    const parts = ['t.workspace_id = ?'];
    const params: unknown[] = [workspaceId];
    if (f.accountId !== undefined) {
        // Des deux côtés : un virement vers ce compte bouge son solde.
        parts.push('(t.account_id = ? OR t.transfer_account_id = ?)');
        params.push(f.accountId, f.accountId);
    }
    if (f.categoryId !== undefined) {
        parts.push('t.category_id = ?');
        params.push(f.categoryId);
    }
    if (f.kind !== undefined) {
        parts.push('t.kind = ?');
        params.push(f.kind);
    }
    if (f.from !== undefined) {
        parts.push('t.date >= ?');
        params.push(f.from);
    }
    if (f.to !== undefined) {
        parts.push('t.date <= ?');
        params.push(f.to);
    }
    if (f.cleared !== undefined) {
        parts.push('t.cleared = ?');
        params.push(f.cleared ? 1 : 0);
    }
    return { sql: parts.join(' AND '), params };
}

/** Rang libre suivant, en bout de liste. */
async function nextRank(q: SdkQueryable, table: 'finance_accounts' | 'finance_categories', workspaceId: number) {
    const rows = await q.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM ${table} WHERE workspace_id = ?`,
        [workspaceId]
    );
    return Number(rows[0]?.next ?? 0);
}

export function createRepo(q: SdkQueryable): FinanceRepo {
    /** Les trois soldes en une passe ; le solde initial est ajouté aux trois. */
    const accountsQuery = (extra: string) => `
        WITH mv AS (${MOVEMENTS})
        SELECT ${ACCOUNT_COLUMNS},
               a.initial_balance + COALESCE(SUM(CASE WHEN mv.date <= ? THEN mv.delta END), 0) AS balance,
               a.initial_balance + COALESCE(SUM(mv.delta), 0) AS projected,
               a.initial_balance
                 + COALESCE(SUM(CASE WHEN mv.cleared = 1 AND mv.date <= ? THEN mv.delta END), 0) AS cleared,
               COUNT(mv.delta) AS transaction_count
          FROM finance_accounts a
          LEFT JOIN mv ON mv.acc = a.id
         WHERE a.workspace_id = ? ${extra}
         GROUP BY a.id
         ORDER BY a.sort_order ASC, a.id ASC`;

    return {
        async getConfig(workspaceId) {
            const rows = await q.query<FinanceConfigRow>(
                `SELECT workspace_id, invoicing_account_id, invoicing_category_id, invoicing_version,
                        legal_status, micro_activity, provision_rate_bp, income_tax_prepaid, declaration_period,
                        DATE_FORMAT(tracking_since, '%Y-%m-%d') AS tracking_since
                   FROM finance_config WHERE workspace_id = ?`,
                [workspaceId]
            );
            return rows[0] ?? null;
        },
        async setStatus(workspaceId, status) {
            await q.execute(
                `INSERT INTO finance_config
                     (workspace_id, legal_status, micro_activity, provision_rate_bp, income_tax_prepaid,
                      declaration_period, tracking_since)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE legal_status = VALUES(legal_status),
                                         micro_activity = VALUES(micro_activity),
                                         provision_rate_bp = VALUES(provision_rate_bp),
                                         income_tax_prepaid = VALUES(income_tax_prepaid),
                                         declaration_period = VALUES(declaration_period),
                                         tracking_since = VALUES(tracking_since)`,
                [
                    workspaceId,
                    status.legalStatus,
                    status.microActivity,
                    status.provisionRateBp,
                    status.incomeTaxPrepaid ? 1 : 0,
                    status.declarationPeriod,
                    status.trackingSince
                ]
            );
        },
        async listDeclaring() {
            return q.query<FinanceDeclaringRow>(
                `SELECT workspace_id, micro_activity, declaration_period, provision_rate_bp, income_tax_prepaid
                   FROM finance_config
                  WHERE legal_status = 'micro' AND micro_activity IS NOT NULL AND declaration_period IS NOT NULL`,
                []
            );
        },
        async markReminder(workspaceId, periodKey, stage) {
            try {
                await q.execute('INSERT INTO ft_finance_reminders (workspace_id, period_key, stage) VALUES (?, ?, ?)', [
                    workspaceId,
                    periodKey,
                    stage
                ]);
                return true;
            } catch (error) {
                if ((error as { code?: string } | null)?.code === 'ER_DUP_ENTRY') return false;
                throw error;
            }
        },
        async setInvoicingLink(workspaceId, accountId, categoryId) {
            await q.execute(
                `INSERT INTO finance_config (workspace_id, invoicing_account_id, invoicing_category_id, invoicing_version)
                 VALUES (?, ?, ?, NULL)
                 ON DUPLICATE KEY UPDATE invoicing_account_id = VALUES(invoicing_account_id),
                                         invoicing_category_id = VALUES(invoicing_category_id),
                                         invoicing_version = NULL`,
                [workspaceId, accountId, categoryId]
            );
        },
        async setInvoicingVersion(workspaceId, version) {
            await q.execute('UPDATE finance_config SET invoicing_version = ? WHERE workspace_id = ?', [
                version,
                workspaceId
            ]);
        },

        async listAccounts(workspaceId, includeArchived, today) {
            return q.query<FinanceAccountBalanceRow>(accountsQuery(includeArchived ? '' : 'AND a.archived = 0'), [
                workspaceId,
                workspaceId,
                today,
                today,
                workspaceId
            ]);
        },
        async findAccount(id, workspaceId, today) {
            const rows = await q.query<FinanceAccountBalanceRow>(accountsQuery('AND a.id = ?'), [
                workspaceId,
                workspaceId,
                today,
                today,
                workspaceId,
                id
            ]);
            return rows[0] ?? null;
        },
        async findAccountPlain(id, workspaceId) {
            const rows = await q.query<FinanceAccountRow>(
                `SELECT ${ACCOUNT_COLUMNS} FROM finance_accounts a WHERE a.id = ? AND a.workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createAccount(workspaceId, input) {
            const sortOrder = await nextRank(q, 'finance_accounts', workspaceId);
            const res = await q.execute(
                `INSERT INTO finance_accounts
                     (workspace_id, kind, color, initial_balance, opened_on, archived, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.kind,
                    input.color,
                    input.initialBalance,
                    input.openedOn,
                    input.archived ? 1 : 0,
                    sortOrder,
                    input.content
                ]
            );
            return res.insertId;
        },
        async updateAccount(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_accounts
                    SET kind = ?, color = ?, initial_balance = ?, opened_on = ?, archived = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.kind,
                    input.color,
                    input.initialBalance,
                    input.openedOn,
                    input.archived ? 1 : 0,
                    input.content,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows > 0;
        },
        async deleteAccount(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_accounts WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorderAccounts(workspaceId, accountIds) {
            for (let i = 0; i < accountIds.length; i++) {
                await q.execute('UPDATE finance_accounts SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    accountIds[i],
                    workspaceId
                ]);
            }
        },
        async countAccountUsage(id, workspaceId) {
            const rows = await q.query<{ count: number }>(
                `SELECT COUNT(*) AS count FROM finance_transactions
                  WHERE workspace_id = ? AND (account_id = ? OR transfer_account_id = ?)`,
                [workspaceId, id, id]
            );
            return Number(rows[0]?.count ?? 0);
        },

        async countAccountRecurring(id, workspaceId) {
            const rows = await q.query<{ count: number }>(
                `SELECT COUNT(*) AS count FROM finance_recurring
                  WHERE workspace_id = ? AND (account_id = ? OR transfer_account_id = ?)`,
                [workspaceId, id, id]
            );
            return Number(rows[0]?.count ?? 0);
        },
        async listCategories(workspaceId) {
            return q.query<FinanceCategoryRow>(
                `SELECT * FROM finance_categories WHERE workspace_id = ?
                  ORDER BY flow ASC, sort_order ASC, id ASC`,
                [workspaceId]
            );
        },
        async findCategory(id, workspaceId) {
            const rows = await q.query<FinanceCategoryRow>(
                'SELECT * FROM finance_categories WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createCategory(workspaceId, input) {
            const sortOrder = await nextRank(q, 'finance_categories', workspaceId);
            const res = await q.execute(
                `INSERT INTO finance_categories (workspace_id, flow, color, icon, role, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [workspaceId, input.flow, input.color, input.icon, input.role, sortOrder, input.content]
            );
            return res.insertId;
        },
        async updateCategory(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_categories SET flow = ?, color = ?, icon = ?, role = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [input.flow, input.color, input.icon, input.role, input.content, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async deleteCategory(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_categories WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },

        async listTransactions(workspaceId, filter, limit, offset) {
            const { sql, params } = whereOf(workspaceId, filter);
            return q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t
                  WHERE ${sql}
                  ORDER BY t.date DESC, t.id DESC
                  LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );
        },
        async countTransactions(workspaceId, filter) {
            const { sql, params } = whereOf(workspaceId, filter);
            const rows = await q.query<{ count: number }>(
                `SELECT COUNT(*) AS count FROM finance_transactions t WHERE ${sql}`,
                params
            );
            return Number(rows[0]?.count ?? 0);
        },
        async sumTransactions(workspaceId, filter) {
            const { sql, params } = whereOf(workspaceId, filter);
            // Les virements sont exclus : déplacer de l'argent n'est ni une recette ni une dépense.
            const rows = await q.query<{ income: number; expense: number }>(
                `SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount END), 0) AS income,
                        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount END), 0) AS expense
                   FROM finance_transactions t WHERE ${sql}`,
                params
            );
            return {
                income: Number(rows[0]?.income ?? 0),
                expense: Number(rows[0]?.expense ?? 0)
            };
        },
        async findTransaction(id, workspaceId) {
            const rows = await q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t WHERE t.id = ? AND t.workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findOccurrence(workspaceId, recurringId, date) {
            const rows = await q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.recurring_id = ? AND t.date = ?`,
                [workspaceId, recurringId, date]
            );
            return rows[0] ?? null;
        },
        async createTransaction(workspaceId, input) {
            const res = await q.execute(
                `INSERT INTO finance_transactions
                     (workspace_id, account_id, transfer_account_id, category_id, recurring_id,
                      source, source_ref, kind, amount, vat_amount, date, cleared, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.recurringId,
                    input.source,
                    input.sourceRef,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.date,
                    input.cleared ? 1 : 0,
                    input.content
                ]
            );
            return res.insertId;
        },
        async updateTransaction(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_transactions
                    SET account_id = ?, transfer_account_id = ?, category_id = ?, kind = ?, amount = ?,
                        vat_amount = ?, date = ?, cleared = ?, content = ?, updated = UNIX_TIMESTAMP()
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.date,
                    input.cleared ? 1 : 0,
                    input.content,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows > 0;
        },
        async deleteTransaction(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_transactions WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async setCleared(workspaceId, ids, cleared) {
            if (ids.length === 0) return;
            // Un seul `IN (...)`, dont les marqueurs sont engendrés depuis la
            // **longueur** du tableau et jamais depuis son contenu.
            const marks = ids.map(() => '?').join(', ');
            await q.execute(
                `UPDATE finance_transactions SET cleared = ?, updated = UNIX_TIMESTAMP()
                  WHERE workspace_id = ? AND id IN (${marks})`,
                [cleared ? 1 : 0, workspaceId, ...ids]
            );
        },

        async listSourced(workspaceId, source) {
            return q.query<FinanceSourcedRow>(
                `SELECT t.id, t.account_id, t.source_ref, t.amount, t.vat_amount,
                        DATE_FORMAT(t.date, '%Y-%m-%d') AS date
                   FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.source = ?`,
                [workspaceId, source]
            );
        },
        async updateSourcedFacts(id, workspaceId, facts) {
            await q.execute(
                `UPDATE finance_transactions SET amount = ?, vat_amount = ?, date = ?, updated = UNIX_TIMESTAMP()
                  WHERE id = ? AND workspace_id = ?`,
                [facts.amount, facts.vatAmount, facts.date, id, workspaceId]
            );
        },
        async listAdoptable(workspaceId, accountId, amount, from, to) {
            return q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.account_id = ? AND t.kind = 'income' AND t.amount = ?
                    AND t.date >= ? AND t.date <= ? AND t.source IS NULL AND t.recurring_id IS NULL`,
                [workspaceId, accountId, amount, from, to]
            );
        },
        async adopt(id, workspaceId, source, sourceRef, content) {
            await q.execute(
                `UPDATE finance_transactions SET source = ?, source_ref = ?, content = ?, updated = UNIX_TIMESTAMP()
                  WHERE id = ? AND workspace_id = ? AND source IS NULL`,
                [source, sourceRef, content, id, workspaceId]
            );
        },

        async totalBalance(workspaceId, today, kinds) {
            const kindClause = kinds && kinds.length > 0 ? `AND a.kind IN (${kinds.map(() => '?').join(', ')})` : '';
            // `SUM(a.initial_balance)` sur une jointure dupliquerait le solde
            // initial autant de fois qu'un compte a de mouvements: on agrège
            // donc par compte d'abord, puis on somme les soldes obtenus.
            const rows = await q.query<{ total: number }>(
                `WITH mv AS (${MOVEMENTS}),
                      per_account AS (
                          SELECT a.id,
                                 a.initial_balance
                                   + COALESCE(SUM(CASE WHEN mv.date <= ? THEN mv.delta END), 0) AS balance
                            FROM finance_accounts a
                            LEFT JOIN mv ON mv.acc = a.id
                           WHERE a.workspace_id = ? ${kindClause}
                           GROUP BY a.id
                      )
                 SELECT COALESCE(SUM(balance), 0) AS total FROM per_account`,
                [workspaceId, workspaceId, today, workspaceId, ...(kinds ?? [])]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async projectedBalance(workspaceId) {
            const rows = await q.query<{ total: number }>(
                `WITH mv AS (${MOVEMENTS}),
                      per_account AS (
                          SELECT a.id, a.initial_balance + COALESCE(SUM(mv.delta), 0) AS balance
                            FROM finance_accounts a
                            LEFT JOIN mv ON mv.acc = a.id
                           WHERE a.workspace_id = ?
                           GROUP BY a.id
                      )
                 SELECT COALESCE(SUM(balance), 0) AS total FROM per_account`,
                [workspaceId, workspaceId, workspaceId]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async categoryShares(workspaceId, from, to) {
            const rows = await q.query<FinanceCategoryShareRow>(
                `SELECT t.category_id,
                        CASE WHEN t.kind = 'income' THEN 'income' ELSE 'expense' END AS flow,
                        SUM(t.amount) AS amount, COUNT(*) AS count
                   FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.date >= ? AND t.date <= ? AND t.kind <> 'transfer'
                  GROUP BY t.category_id, flow
                  ORDER BY amount DESC`,
                [workspaceId, from, to]
            );
            return rows.map((row) => ({
                ...row,
                amount: Number(row.amount),
                count: Number(row.count)
            }));
        },
        async monthlyFlow(workspaceId, from, to) {
            const rows = await q.query<FinanceMonthRow>(
                `SELECT DATE_FORMAT(t.date, '%Y-%m') AS month,
                        COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount END), 0) AS income,
                        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount END), 0) AS expense
                   FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.date >= ? AND t.date <= ?
                  GROUP BY month
                  ORDER BY month ASC`,
                [workspaceId, from, to]
            );
            return rows.map((row) => ({
                month: row.month,
                income: Number(row.income),
                expense: Number(row.expense)
            }));
        },
        async vatTotals(workspaceId, from, to) {
            // Collectée sur les recettes, déductible sur les dépenses. Les
            // virements n'en portent pas: rien n'est vendu ni acheté.
            const rows = await q.query<{ collected: number; deductible: number }>(
                `SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.vat_amount END), 0) AS collected,
                        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.vat_amount END), 0) AS deductible
                   FROM finance_transactions t
                  WHERE t.workspace_id = ? AND t.date >= ? AND t.date <= ? AND t.vat_amount IS NOT NULL`,
                [workspaceId, from, to]
            );
            return {
                collected: Number(rows[0]?.collected ?? 0),
                deductible: Number(rows[0]?.deductible ?? 0)
            };
        },
        async revenueBetween(workspaceId, from, to) {
            const rows = await q.query<{ total: number }>(
                `SELECT COALESCE(SUM(t.amount - COALESCE(t.vat_amount, 0)), 0) AS total
                   FROM finance_transactions t
                   LEFT JOIN finance_categories c ON c.id = t.category_id
                  WHERE t.workspace_id = ? AND t.kind = 'income' AND t.date >= ? AND t.date <= ?
                    AND (c.role IS NULL OR c.role <> 'other')`,
                [workspaceId, from, to]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async chargesBetween(workspaceId, from, to) {
            const rows = await q.query<{ total: number }>(
                `SELECT COALESCE(SUM(t.amount - COALESCE(t.vat_amount, 0)), 0) AS total
                   FROM finance_transactions t
                   LEFT JOIN finance_categories c ON c.id = t.category_id
                  WHERE t.workspace_id = ? AND t.kind = 'expense' AND t.date >= ? AND t.date <= ?
                    AND c.role IS NULL`,
                [workspaceId, from, to]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async paidByRoles(workspaceId, roles, from, to) {
            if (roles.length === 0) return 0;
            const marks = roles.map(() => '?').join(', ');
            const rows = await q.query<{ total: number }>(
                `SELECT COALESCE(SUM(t.amount), 0) AS total
                   FROM finance_transactions t
                   JOIN finance_categories c ON c.id = t.category_id
                  WHERE t.workspace_id = ? AND t.kind = 'expense' AND t.date >= ? AND t.date <= ?
                    AND c.role IN (${marks})`,
                [workspaceId, from, to, ...roles]
            );
            return Number(rows[0]?.total ?? 0);
        },

        async listRecurring(workspaceId) {
            return q.query<FinanceRecurringRow>(
                `SELECT ${REC_COLUMNS} FROM finance_recurring r WHERE r.workspace_id = ?
                  ORDER BY r.active DESC, r.next_date ASC, r.id ASC`,
                [workspaceId]
            );
        },
        async listDueRecurring(workspaceId, onOrBefore, automatic) {
            const clause = automatic === undefined ? '' : 'AND r.automatic = ?';
            return q.query<FinanceRecurringRow>(
                `SELECT ${REC_COLUMNS} FROM finance_recurring r
                  WHERE r.workspace_id = ? AND r.active = 1 AND r.next_date <= ?
                    AND (r.end_date IS NULL OR r.next_date <= r.end_date) ${clause}
                  ORDER BY r.next_date ASC, r.id ASC`,
                automatic === undefined ? [workspaceId, onOrBefore] : [workspaceId, onOrBefore, automatic ? 1 : 0]
            );
        },
        async findRecurring(id, workspaceId) {
            const rows = await q.query<FinanceRecurringRow>(
                `SELECT ${REC_COLUMNS} FROM finance_recurring r WHERE r.id = ? AND r.workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createRecurring(workspaceId, input) {
            const res = await q.execute(
                `INSERT INTO finance_recurring
                     (workspace_id, account_id, transfer_account_id, category_id, kind, amount, vat_amount,
                      frequency, interval_count, next_date, anchor_day, end_date, automatic, active, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.frequency,
                    input.interval,
                    input.nextDate,
                    input.anchorDay,
                    input.endDate,
                    input.automatic ? 1 : 0,
                    input.active ? 1 : 0,
                    input.content
                ]
            );
            return res.insertId;
        },
        async updateRecurring(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE finance_recurring
                    SET account_id = ?, transfer_account_id = ?, category_id = ?, kind = ?, amount = ?,
                        vat_amount = ?, frequency = ?, interval_count = ?, next_date = ?, anchor_day = ?,
                        end_date = ?, automatic = ?, active = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.accountId,
                    input.transferAccountId,
                    input.categoryId,
                    input.kind,
                    input.amount,
                    input.vatAmount,
                    input.frequency,
                    input.interval,
                    input.nextDate,
                    input.anchorDay,
                    input.endDate,
                    input.automatic ? 1 : 0,
                    input.active ? 1 : 0,
                    input.content,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows > 0;
        },
        async deleteRecurring(id, workspaceId) {
            const res = await q.execute('DELETE FROM finance_recurring WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async createImport(workspaceId, input) {
            const res = await q.execute(
                `INSERT INTO ft_finance_imports
                     (workspace_id, account_id, format, first_date, last_date, line_count, new_count,
                      closing_balance, closing_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.accountId,
                    input.format,
                    input.firstDate,
                    input.lastDate,
                    input.lineCount,
                    input.newCount,
                    input.closingBalance,
                    input.closingDate
                ]
            );
            return res.insertId;
        },
        async setImportCounts(id, workspaceId, lineCount, newCount) {
            await q.execute(
                'UPDATE ft_finance_imports SET line_count = ?, new_count = ? WHERE id = ? AND workspace_id = ?',
                [lineCount, newCount, id, workspaceId]
            );
        },
        async latestClosings(workspaceId) {
            const rows = await q.query<{ account_id: number; closing_balance: number; closing_date: string }>(
                `SELECT account_id, closing_balance, DATE_FORMAT(closing_date, '%Y-%m-%d') AS closing_date
                   FROM ft_finance_imports
                  WHERE workspace_id = ? AND closing_balance IS NOT NULL AND closing_date IS NOT NULL
                  ORDER BY closing_date DESC, id DESC`,
                [workspaceId]
            );
            const seen = new Set<number>();
            return rows.filter((row) => {
                if (seen.has(row.account_id)) return false;
                seen.add(row.account_id);
                return true;
            });
        },
        async insertLine(workspaceId, input) {
            try {
                const res = await q.execute(
                    `INSERT INTO ft_finance_statement_lines
                         (workspace_id, account_id, import_id, external_id, date, direction, amount, content)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        workspaceId,
                        input.accountId,
                        input.importId,
                        input.externalId,
                        input.date,
                        input.direction,
                        input.amount,
                        input.content
                    ]
                );
                return res.insertId;
            } catch (error) {
                if (isDuplicateEntry(error)) return null;
                throw error;
            }
        },
        async findLines(workspaceId, ids) {
            if (ids.length === 0) return [];
            const marks = ids.map(() => '?').join(', ');
            return q.query<FinanceStatementLineRow>(
                `SELECT ${LINE_COLUMNS} FROM ft_finance_statement_lines l
                  WHERE l.workspace_id = ? AND l.id IN (${marks})`,
                [workspaceId, ...ids]
            );
        },
        async listLines(workspaceId, filter, limit) {
            const parts = ['l.workspace_id = ?'];
            const params: unknown[] = [workspaceId];
            if (filter.pendingOnly) parts.push('l.transaction_id IS NULL AND l.ignored = 0');
            if (filter.accountId !== undefined) {
                parts.push('l.account_id = ?');
                params.push(filter.accountId);
            }
            return q.query<FinanceStatementLineRow>(
                `SELECT ${LINE_COLUMNS} FROM ft_finance_statement_lines l
                  WHERE ${parts.join(' AND ')}
                  ORDER BY (l.transaction_id IS NULL AND l.ignored = 0) DESC, l.date DESC, l.id DESC
                  LIMIT ?`,
                [...params, limit]
            );
        },
        async countPendingLines(workspaceId, accountId) {
            const rows = await q.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM ft_finance_statement_lines
                  WHERE workspace_id = ? AND transaction_id IS NULL AND ignored = 0
                    ${accountId === undefined ? '' : 'AND account_id = ?'}`,
                accountId === undefined ? [workspaceId] : [workspaceId, accountId]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async linkLine(id, workspaceId, transactionId) {
            await q.execute(
                'UPDATE ft_finance_statement_lines SET transaction_id = ? WHERE id = ? AND workspace_id = ?',
                [transactionId, id, workspaceId]
            );
        },
        async setLineIgnored(ids, workspaceId, ignored) {
            if (ids.length === 0) return;
            const marks = ids.map(() => '?').join(', ');
            await q.execute(
                `UPDATE ft_finance_statement_lines SET ignored = ?
                  WHERE workspace_id = ? AND transaction_id IS NULL AND id IN (${marks})`,
                [ignored ? 1 : 0, workspaceId, ...ids]
            );
        },
        async unconfirmedTransactions(workspaceId, accountId, from, to) {
            return q.query<FinanceTransactionRow>(
                `SELECT ${TX_COLUMNS} FROM finance_transactions t
                  WHERE t.workspace_id = ? AND (t.account_id = ? OR t.transfer_account_id = ?)
                    AND t.date >= ? AND t.date <= ?
                    AND NOT EXISTS (SELECT 1 FROM ft_finance_statement_lines l
                                     WHERE l.transaction_id = t.id AND l.account_id = ?)
                  ORDER BY t.date ASC, t.id ASC`,
                [workspaceId, accountId, accountId, from, to, accountId]
            );
        },
        async linkedLines(workspaceId, transactionId) {
            return q.query<FinanceStatementLineRow>(
                `SELECT ${LINE_COLUMNS} FROM ft_finance_statement_lines l
                  WHERE l.workspace_id = ? AND l.transaction_id = ?`,
                [workspaceId, transactionId]
            );
        },
        async releaseLines(transactionId, workspaceId) {
            await q.execute(
                'UPDATE ft_finance_statement_lines SET transaction_id = NULL, ignored = 1 WHERE transaction_id = ? AND workspace_id = ?',
                [transactionId, workspaceId]
            );
        },
        async countAccountLines(id, workspaceId) {
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM ft_finance_statement_lines WHERE workspace_id = ? AND account_id = ?',
                [workspaceId, id]
            );
            return Number(rows[0]?.n ?? 0);
        },

        async listRules(workspaceId) {
            return q.query<FinanceRuleRow>(
                `SELECT id, workspace_id, direction, category_id, vat_rate_bp, sort_order, hits, content
                   FROM ft_finance_rules WHERE workspace_id = ? ORDER BY sort_order ASC, id ASC`,
                [workspaceId]
            );
        },
        async findRule(id, workspaceId) {
            const rows = await q.query<FinanceRuleRow>(
                `SELECT id, workspace_id, direction, category_id, vat_rate_bp, sort_order, hits, content
                   FROM ft_finance_rules WHERE id = ? AND workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createRule(workspaceId, input) {
            const rank = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM ft_finance_rules WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await q.execute(
                `INSERT INTO ft_finance_rules (workspace_id, direction, category_id, vat_rate_bp, sort_order, content)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    workspaceId,
                    input.direction,
                    input.categoryId,
                    input.vatRateBp,
                    Number(rank[0]?.next ?? 0),
                    input.content
                ]
            );
            return res.insertId;
        },
        async updateRule(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE ft_finance_rules SET direction = ?, category_id = ?, vat_rate_bp = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [input.direction, input.categoryId, input.vatRateBp, input.content, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async deleteRule(id, workspaceId) {
            const res = await q.execute('DELETE FROM ft_finance_rules WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async bumpRuleHits(id, workspaceId, by) {
            await q.execute('UPDATE ft_finance_rules SET hits = hits + ? WHERE id = ? AND workspace_id = ?', [
                by,
                id,
                workspaceId
            ]);
        },

        async listConnections(workspaceId) {
            return q.query<FinanceConnectionRow>(
                `SELECT ${CONNECTION_COLUMNS} FROM ft_finance_connections
                  WHERE workspace_id = ? ORDER BY created ASC, id ASC`,
                [workspaceId]
            );
        },
        async findConnection(id, workspaceId) {
            const rows = await q.query<FinanceConnectionRow>(
                `SELECT ${CONNECTION_COLUMNS} FROM ft_finance_connections WHERE id = ? AND workspace_id = ?`,
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },
        async createConnection(workspaceId, input) {
            const res = await q.execute(
                `INSERT INTO ft_finance_connections (workspace_id, provider, valid_until, content)
                 VALUES (?, ?, ?, ?)`,
                [workspaceId, input.provider, input.validUntil, input.content]
            );
            return res.insertId;
        },
        async setConnectionContent(id, workspaceId, content) {
            const res = await q.execute(
                'UPDATE ft_finance_connections SET content = ? WHERE id = ? AND workspace_id = ?',
                [content, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async replaceConnection(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE ft_finance_connections
                    SET content = ?, valid_until = ?, status = 'ok', error = NULL
                  WHERE id = ? AND workspace_id = ?`,
                [input.content, input.validUntil, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async recordSync(id, workspaceId, at, status, error) {
            await q.execute(
                `UPDATE ft_finance_connections SET last_sync_at = ?, status = ?, error = ?
                  WHERE id = ? AND workspace_id = ?`,
                [at, status, error, id, workspaceId]
            );
        },
        async deleteConnection(id, workspaceId) {
            const res = await q.execute('DELETE FROM ft_finance_connections WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async countConnectionsInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM ft_finance_connections WHERE workspace_id IN (?)',
                [[...workspaceIds]]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async countProviderConnections(provider) {
            const rows = await q.query<{ total: number; failing: number | null }>(
                `SELECT COUNT(*) AS total, SUM(status <> 'ok') AS failing
                   FROM ft_finance_connections WHERE provider = ?`,
                [provider]
            );
            return { total: Number(rows[0]?.total ?? 0), failing: Number(rows[0]?.failing ?? 0) };
        },
        async listStockConnections(workspaceIds) {
            if (workspaceIds.length === 0) return [];
            const rows = await q.query<{ id: number; workspace_id: number }>(
                `SELECT id, workspace_id FROM ft_finance_connections
                  WHERE workspace_id IN (?) ORDER BY created ASC, id ASC`,
                [[...workspaceIds]]
            );
            return rows.map((row) => ({ id: String(row.id), workspaceId: Number(row.workspace_id) }));
        },
        async listDueConnections(before, pausedIds, limit) {
            const paused = pausedIds.length > 0;
            return q.query<FinanceConnectionRow>(
                `SELECT ${CONNECTION_COLUMNS} FROM ft_finance_connections
                  WHERE status <> 'expired' AND (last_sync_at IS NULL OR last_sync_at < ?)
                    ${paused ? 'AND id NOT IN (?)' : ''}
                  ORDER BY last_sync_at IS NULL DESC, last_sync_at ASC, id ASC
                  LIMIT ?`,
                paused ? [before, [...pausedIds], limit] : [before, limit]
            );
        },
        async listExpiringConnections(before) {
            return q.query<FinanceConnectionRow>(
                `SELECT ${CONNECTION_COLUMNS} FROM ft_finance_connections
                  WHERE valid_until IS NOT NULL AND valid_until < ? AND status <> 'expired'`,
                [before]
            );
        },
        async claimExpiryWarning(id, workspaceId) {
            const res = await q.execute(
                `UPDATE ft_finance_connections SET warned_until = valid_until
                  WHERE id = ? AND workspace_id = ? AND valid_until IS NOT NULL
                    AND (warned_until IS NULL OR warned_until <> valid_until)`,
                [id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async markExpired(id, workspaceId) {
            const res = await q.execute(
                `UPDATE ft_finance_connections SET status = 'expired'
                  WHERE id = ? AND workspace_id = ? AND status <> 'expired'`,
                [id, workspaceId]
            );
            return res.affectedRows > 0;
        },

        async listBankLinks(workspaceId) {
            return q.query<FinanceBankLinkRow>(
                `SELECT ${LINK_COLUMNS} FROM ft_finance_bank_links WHERE workspace_id = ?`,
                [workspaceId]
            );
        },
        async listConnectionLinks(connectionId, workspaceId) {
            return q.query<FinanceBankLinkRow>(
                `SELECT ${LINK_COLUMNS} FROM ft_finance_bank_links WHERE connection_id = ? AND workspace_id = ?`,
                [connectionId, workspaceId]
            );
        },
        async setBankLink(accountId, workspaceId, link) {
            // Pas d'`ON DUPLICATE KEY UPDATE` : sur la clé du compte distant, il
            // réécrirait le lien d'un AUTRE compte du livre au lieu de refuser.
            await q.execute('DELETE FROM ft_finance_bank_links WHERE account_id = ? AND workspace_id = ?', [
                accountId,
                workspaceId
            ]);
            if (link === null) return;
            await q.execute(
                `INSERT INTO ft_finance_bank_links (account_id, workspace_id, connection_id, external_account_id, since)
                 VALUES (?, ?, ?, ?, ?)`,
                [accountId, workspaceId, link.connectionId, link.externalAccountId, link.since]
            );
        },
        async latestLineDate(accountId, workspaceId) {
            const rows = await q.query<{ last: string | null }>(
                `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS last FROM ft_finance_statement_lines
                  WHERE account_id = ? AND workspace_id = ?`,
                [accountId, workspaceId]
            );
            return rows[0]?.last ?? null;
        },

        async advanceRecurring(id, workspaceId, nextDate, lastPostedDate, active) {
            // `COALESCE` porte ici tout le contrat: un argument à `null` veut
            // dire « ne touche pas », et non « mets NULL ».
            await q.execute(
                `UPDATE finance_recurring
                    SET next_date = ?,
                        last_posted_date = COALESCE(?, last_posted_date),
                        active = COALESCE(?, active)
                  WHERE id = ? AND workspace_id = ?`,
                [nextDate, lastPostedDate, active === null ? null : active ? 1 : 0, id, workspaceId]
            );
        }
    };
}
