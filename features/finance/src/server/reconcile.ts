import { createHmac } from 'node:crypto';

import type { InvoicingLedgerReceivable } from '@deveye/types/sdk';

import type { BankProvider } from '../contracts/banking';
import type { FinanceTransactionRow } from '../contracts/domain';
import {
    normalizeLabel,
    type FinanceStatementLineRow,
    type StatementLineInput,
    type StatementProposal
} from '../contracts/statement';
import {
    addDays,
    decryptJson,
    encryptJson,
    financeCipher,
    readConfig,
    type Ctx,
    type LedgerIo,
    type StoredEntry
} from './_shared';

/**
 * Le rapprochement : ce qui fait d'une ligne de relevé une opération du livre
 * sans la retaper. Deux gestes seulement, et jamais un choix à la place de la
 * personne : une opération déjà au livre qu'elle confirme, quand il n'y en a
 * qu'une ; sinon une règle qui la range. Le reste attend, avec ce qu'il
 * pourrait être.
 */

/**
 * La fenêtre d'une opération autour de sa ligne : saisie un peu avant (le jour
 * de la facture, le jour du paiement par carte), passée un peu après par la
 * banque.
 */
const MATCH_BEFORE_DAYS = 5;
const MATCH_AFTER_DAYS = 3;

/** Une échéance manuelle se propose pour une ligne à ce nombre de jours près. */
const RECURRING_WINDOW_DAYS = 10;

const PROPOSALS_MAX = 3;

/** Ce que porte `ft_finance_statement_lines.content`. */
export interface StoredLine {
    label: string;
    memo: string;
}

/** Ce que porte `ft_finance_rules.content`. */
export interface StoredRule {
    contains: string;
}

/** L'opération confirme-t-elle cette ligne : même compte, même sens, même montant. */
export function fitsLine(
    t: FinanceTransactionRow,
    line: Pick<FinanceStatementLineRow, 'account_id' | 'direction' | 'amount'>
): boolean {
    if (Number(t.amount) !== Number(line.amount)) return false;
    const account = line.account_id;
    if (line.direction === 'in') {
        return (
            (t.kind === 'income' && t.account_id === account) ||
            (t.kind === 'transfer' && t.transfer_account_id === account)
        );
    }
    return (t.kind === 'expense' && t.account_id === account) || (t.kind === 'transfer' && t.account_id === account);
}

function withinWindow(transactionDate: string, lineDate: string): boolean {
    return (
        transactionDate >= addDays(lineDate, -MATCH_BEFORE_DAYS) &&
        transactionDate <= addDays(lineDate, MATCH_AFTER_DAYS)
    );
}

/**
 * L'identité d'une ligne chez la banque. Un OFX la donne (`FITID`), une
 * connexion aussi (préfixée par son fournisseur). Un CSV non :
 * une empreinte signée du compte, du jour, du sens, du montant, du libellé et du
 * rang parmi les lignes identiques du même fichier (deux cafés le même jour
 * restent deux). Signée par une clé du serveur : l'empreinte ne rend pas le
 * libellé qu'elle protège.
 */
export function lineIdentities(
    io: Pick<Ctx, 'keys'>,
    accountId: number,
    lines: readonly StatementLineInput[],
    source: 'ofx' | BankProvider = 'ofx'
): string[] {
    const key = io.keys.derive('finance.statement', 'line-identity', 32);
    const seen = new Map<string, number>();
    return lines.map((line) => {
        if (line.fitid !== null) return `${source}:${line.fitid}`;
        const base = `${accountId}|${line.date}|${line.direction}|${line.amount}|${normalizeLabel(`${line.label} ${line.memo}`)}`;
        const rank = seen.get(base) ?? 0;
        seen.set(base, rank + 1);
        return `csv:${createHmac('sha256', key).update(`${base}|${rank}`).digest('hex').slice(0, 40)}`;
    });
}

/** La part de TVA d'un montant toutes taxes comprises, à ce taux. */
export function vatOfGross(gross: number, rateBp: number): number {
    return Math.round(gross - (gross * 10_000) / (10_000 + rateBp));
}

/**
 * Rapproche les lignes en attente d'un compte. Rend combien ont trouvé leur
 * opération, et combien une règle a rangées. Sans effet quand il n'y a rien en
 * attente : l'appeler souvent ne coûte qu'une requête.
 */
export async function reconcileAccount(io: LedgerIo, accountId: number): Promise<{ matched: number; ruled: number }> {
    const pending = await io.repo.listLines(io.workspaceId, { pendingOnly: true, accountId }, 5_000);
    if (pending.length === 0) return { matched: 0, ruled: 0 };
    const ordered = [...pending].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));

    const candidates = await io.repo.unconfirmedTransactions(
        io.workspaceId,
        accountId,
        addDays(ordered[0].date, -MATCH_BEFORE_DAYS),
        addDays(ordered[ordered.length - 1].date, MATCH_AFTER_DAYS)
    );
    const used = new Set<number>();
    const left: FinanceStatementLineRow[] = [];
    let matched = 0;
    for (const line of ordered) {
        const fits = candidates.filter((t) => !used.has(t.id) && fitsLine(t, line) && withinWindow(t.date, line.date));
        if (fits.length !== 1) {
            left.push(line);
            continue;
        }
        const [t] = fits;
        used.add(t.id);
        await io.repo.linkLine(line.id, io.workspaceId, t.id);
        await io.repo.setCleared(io.workspaceId, [t.id], true);
        matched += 1;
    }
    const ruled = await applyRules(io, accountId, left);
    return { matched, ruled };
}

/** Les comptes qui ont des lignes en attente, rapprochés un à un. */
export async function reconcilePending(io: LedgerIo): Promise<void> {
    const pending = await io.repo.listLines(io.workspaceId, { pendingOnly: true }, 5_000);
    for (const accountId of new Set(pending.map((line) => line.account_id))) {
        await reconcileAccount(io, accountId);
    }
}

/** Range par les règles ce qu'aucune opération ne confirme. La première règle qui reconnaît la ligne l'emporte. */
async function applyRules(io: LedgerIo, accountId: number, lines: readonly FinanceStatementLineRow[]): Promise<number> {
    if (lines.length === 0) return 0;
    const [ruleRows, categoryRows] = await Promise.all([
        io.repo.listRules(io.workspaceId),
        io.repo.listCategories(io.workspaceId)
    ]);
    if (ruleRows.length === 0) return 0;
    const cipher = financeCipher(io);
    // Une TVA ne se récupère qu'au régime réel : en franchise, la règle range sans elle.
    const { vatEnabled } = await readConfig(io);
    const flows = new Map(categoryRows.map((category) => [category.id, category.flow]));
    const rules: {
        id: number;
        direction: string | null;
        categoryId: number;
        vatRateBp: number | null;
        contains: string;
    }[] = [];
    for (const row of ruleRows) {
        const stored = await decryptJson<StoredRule>(cipher, row.content);
        const contains = normalizeLabel(stored?.contains ?? '');
        if (contains !== '') {
            rules.push({
                id: row.id,
                direction: row.direction,
                categoryId: row.category_id,
                vatRateBp: row.vat_rate_bp,
                contains
            });
        }
    }

    const hits = new Map<number, number>();
    let ruled = 0;
    for (const line of lines) {
        const stored = await decryptJson<StoredLine>(cipher, line.content);
        const text = normalizeLabel(`${stored?.label ?? ''} ${stored?.memo ?? ''}`);
        const flow = line.direction === 'in' ? 'income' : 'expense';
        const rule = rules.find(
            (candidate) =>
                (candidate.direction === null || candidate.direction === line.direction) &&
                flows.get(candidate.categoryId) === flow &&
                text.includes(candidate.contains)
        );
        if (rule === undefined) continue;
        const payload: StoredEntry = { label: stored?.label ?? '', counterparty: '', note: '' };
        const id = await io.repo.createTransaction(io.workspaceId, {
            accountId,
            transferAccountId: null,
            categoryId: rule.categoryId,
            recurringId: null,
            source: null,
            sourceRef: null,
            kind: flow,
            amount: Number(line.amount),
            vatAmount:
                !vatEnabled || rule.vatRateBp === null || rule.vatRateBp === 0
                    ? null
                    : vatOfGross(Number(line.amount), rule.vatRateBp),
            date: line.date,
            cleared: true,
            content: await encryptJson(cipher, payload)
        });
        await io.repo.linkLine(line.id, io.workspaceId, id);
        hits.set(rule.id, (hits.get(rule.id) ?? 0) + 1);
        ruled += 1;
    }
    for (const [id, by] of hits) await io.repo.bumpRuleHits(id, io.workspaceId, by);
    return ruled;
}

/**
 * Ce que chaque ligne en attente pourrait être, pour que la personne choisisse
 * d'un clic : les opérations du livre au même montant (quand il y en a plusieurs),
 * une échéance manuelle due au même montant, une facture qui attend exactement
 * ce montant. Une facture ne se propose que sur le compte qui reçoit les
 * règlements : c'est là que sa copie arrivera et confirmera la ligne.
 */
export async function proposalsFor(
    io: LedgerIo,
    lines: readonly FinanceStatementLineRow[],
    receivables: readonly InvoicingLedgerReceivable[],
    receivingAccountId: number | null
): Promise<Map<number, StatementProposal[]>> {
    const proposals = new Map<number, StatementProposal[]>();
    const pending = lines.filter((line) => line.transaction_id === null && line.ignored === 0);
    if (pending.length === 0) return proposals;
    const cipher = financeCipher(io);
    const labelOf = async (content: string) => (await decryptJson<StoredEntry>(cipher, content))?.label ?? '';

    const dates = pending.map((line) => line.date).sort();
    const due = await io.repo.listDueRecurring(
        io.workspaceId,
        addDays(dates[dates.length - 1], RECURRING_WINDOW_DAYS),
        false
    );

    for (const accountId of new Set(pending.map((line) => line.account_id))) {
        const mine = pending.filter((line) => line.account_id === accountId);
        const sorted = mine.map((line) => line.date).sort();
        const candidates = await io.repo.unconfirmedTransactions(
            io.workspaceId,
            accountId,
            addDays(sorted[0], -MATCH_BEFORE_DAYS),
            addDays(sorted[sorted.length - 1], MATCH_AFTER_DAYS)
        );
        for (const line of mine) {
            const found: StatementProposal[] = [];
            for (const t of candidates
                .filter((c) => fitsLine(c, line) && withinWindow(c.date, line.date))
                .slice(0, PROPOSALS_MAX)) {
                found.push({ kind: 'transaction', transactionId: t.id, label: await labelOf(t.content), date: t.date });
            }
            const flow = line.direction === 'in' ? 'income' : 'expense';
            for (const r of due) {
                const near =
                    r.next_date >= addDays(line.date, -RECURRING_WINDOW_DAYS) &&
                    r.next_date <= addDays(line.date, RECURRING_WINDOW_DAYS);
                if (r.account_id === accountId && r.kind === flow && Number(r.amount) === Number(line.amount) && near) {
                    found.push({
                        kind: 'recurring',
                        recurringId: r.id,
                        label: await labelOf(r.content),
                        date: r.next_date
                    });
                }
            }
            if (line.direction === 'in' && accountId === receivingAccountId) {
                for (const receivable of receivables
                    .filter((r) => r.remainingCents === Number(line.amount))
                    .slice(0, PROPOSALS_MAX)) {
                    found.push({
                        kind: 'invoice',
                        docId: receivable.docId,
                        docNumber: receivable.docNumber,
                        clientName: receivable.clientName,
                        segment: receivable.segment
                    });
                }
            }
            if (found.length > 0) proposals.set(line.id, found);
        }
    }
    return proposals;
}
