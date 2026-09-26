import type {
    BankConnection,
    BankConnectionStatus,
    BankLink,
    BankPsuType,
    BankRemoteAccount,
    FinanceBankLinkRow,
    FinanceConnectionRow
} from '../contracts/banking';
import { enableBankingApp, enableBankingConnector, type EnableBankingSecret } from './banks/enableBanking';
import { qontoConnector, type QontoSecret } from './banks/qonto';
import { BankError, type BankConnector } from './banks/types';
import { lineIdentities, reconcileAccount } from './reconcile';
import { addDays, decryptJson, encryptJson, financeCipher, today, type Ctx, type LedgerIo } from './_shared';

/**
 * La relève d'une connexion bancaire : pour chaque compte du livre qu'elle
 * alimente, les lignes comptabilisées depuis la dernière relève (une semaine
 * de recouvrement, qu'un doublon ne franchit pas), le solde de la banque, puis
 * le rapprochement. Les mêmes lignes qu'un import, par le même chemin.
 */

/** Ce qu'une relève relit en arrière de la dernière ligne : une opération peut être comptabilisée à une date passée. */
const OVERLAP_DAYS = 7;

/** L'historique qu'une banque rend sans redemander le consentement de son titulaire (DSP2). */
const PSD2_HISTORY_DAYS = 89;

/** Le retour de la banque après le consentement arrive sur cette route (`routes.ts`). */
export const BANK_CALLBACK_PATH = '/api/finance/bank/callback';

/** Ce que porte `ft_finance_connections.content`. */
export interface StoredConnection {
    label: string;
    bankName: string;
    /** Enable Banking : de quoi reconnecter la même banque sans tout redemander. */
    country?: string;
    psuType?: BankPsuType;
    secret: QontoSecret | EnableBankingSecret;
    /** `key` : ce qui reconnaît un compte d'Enable Banking d'une session à la suivante. */
    accounts: (BankRemoteAccount & { key?: string })[];
}

/** Le chiffre, les clés et le livre : un handler, ou le service de fond pour un espace. */
export type BankIo = LedgerIo & Pick<Ctx, 'keys'>;

export function isQontoSecret(secret: StoredConnection['secret']): secret is QontoSecret {
    return 'login' in secret;
}

export async function readConnection(
    io: Pick<Ctx, 'cipher'>,
    row: FinanceConnectionRow
): Promise<StoredConnection | null> {
    return decryptJson<StoredConnection>(financeCipher(io), row.content);
}

export async function sealConnection(io: Pick<Ctx, 'cipher'>, stored: StoredConnection): Promise<string> {
    return encryptJson(financeCipher(io), stored);
}

/** Une connexion telle que l'écran la montre : jamais ses accès. */
export function toConnection(
    row: FinanceConnectionRow,
    stored: StoredConnection | null,
    paused: boolean
): BankConnection {
    return {
        id: row.id,
        provider: row.provider,
        label: stored?.label ?? '',
        bankName: stored?.bankName ?? '',
        country: stored?.country ?? null,
        psuType: stored?.psuType ?? null,
        status: row.status,
        error: stored === null ? 'Les accès de cette connexion ne se lisent plus.' : row.error,
        validUntil: row.valid_until === null ? null : Number(row.valid_until),
        lastSyncAt: row.last_sync_at === null ? null : Number(row.last_sync_at),
        accounts: (stored?.accounts ?? []).map(({ id, name, ibanEnd, currency }) => ({ id, name, ibanEnd, currency })),
        paused,
        created: Number(row.created)
    };
}

export function toLink(row: FinanceBankLinkRow): BankLink {
    return {
        accountId: row.account_id,
        connectionId: row.connection_id,
        externalAccountId: row.external_account_id,
        since: row.since
    };
}

export function connectorOf(stored: StoredConnection): BankConnector {
    if (isQontoSecret(stored.secret)) return qontoConnector(stored.secret);
    const app = enableBankingApp();
    if (app === null) {
        throw new BankError(
            'auth',
            'Ce serveur ne relie plus d’autres banques que Qonto : prévenez son administrateur.'
        );
    }
    return enableBankingConnector(app, stored.accounts);
}

export interface SyncOutcome {
    added: number;
    status: BankConnectionStatus;
    error: string | null;
}

/** Une relève à la fois par connexion : le service et un clic simultanés partagent la même. */
const inFlight = new Map<number, Promise<SyncOutcome>>();

export function syncConnection(io: BankIo, row: FinanceConnectionRow): Promise<SyncOutcome> {
    const running = inFlight.get(row.id);
    if (running) return running;
    const task = runSync(io, row).finally(() => inFlight.delete(row.id));
    inFlight.set(row.id, task);
    return task;
}

async function runSync(io: BankIo, row: FinanceConnectionRow): Promise<SyncOutcome> {
    const at = Math.floor(Date.now() / 1000);
    if (row.valid_until !== null && Number(row.valid_until) <= at) {
        await io.repo.markExpired(row.id, io.workspaceId);
        return { added: 0, status: 'expired', error: null };
    }
    let added = 0;
    try {
        const stored = await readConnection(io, row);
        if (stored === null) {
            throw new BankError('auth', 'Les accès de cette connexion ne se lisent plus : saisissez-les à nouveau.');
        }
        const connector = connectorOf(stored);
        for (const link of await io.repo.listConnectionLinks(row.id, io.workspaceId)) {
            added += await syncAccount(io, row, connector, link);
        }
        await io.repo.recordSync(row.id, io.workspaceId, at, 'ok', null);
        return { added, status: 'ok', error: null };
    } catch (error) {
        const known = error instanceof BankError;
        if (!known) io.logger.warn({ err: error, connectionId: row.id }, 'finance: relève bancaire interrompue');
        const status: BankConnectionStatus = known && error.kind === 'expired' ? 'expired' : 'error';
        const message = known ? error.message : 'La relève a échoué : la suivante réessaiera.';
        await io.repo.recordSync(row.id, io.workspaceId, at, status, message);
        return { added, status, error: message };
    }
}

/** Le premier jour à relire pour ce compte. */
async function sinceOf(io: BankIo, row: FinanceConnectionRow, link: FinanceBankLinkRow): Promise<string> {
    let since = link.since;
    const latest = await io.repo.latestLineDate(link.account_id, io.workspaceId);
    if (latest !== null && addDays(latest, -OVERLAP_DAYS) > since) since = addDays(latest, -OVERLAP_DAYS);
    if (row.provider === 'enablebanking') {
        const floor = addDays(today(), -PSD2_HISTORY_DAYS);
        if (since < floor) since = floor;
    }
    return since;
}

async function syncAccount(
    io: BankIo,
    row: FinanceConnectionRow,
    connector: BankConnector,
    link: FinanceBankLinkRow
): Promise<number> {
    const account = await io.repo.findAccountPlain(link.account_id, io.workspaceId);
    if (!account || account.archived === 1) return 0;
    const lines = await connector.transactions(link.external_account_id, await sinceOf(io, row, link));
    const identities = lineIdentities(io, link.account_id, lines, row.provider);
    const cipher = financeCipher(io);
    let added = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const id = await io.repo.insertLine(io.workspaceId, {
            accountId: link.account_id,
            importId: null,
            externalId: identities[i],
            date: line.date,
            direction: line.direction,
            amount: line.amount,
            content: await encryptJson(cipher, { label: line.label, memo: line.memo })
        });
        if (id !== null) added += 1;
    }

    // Le solde de la banque ne s'écrit que quand il apporte quelque chose : une
    // ligne toutes les six heures pour dire la même chose n'apprendrait rien.
    const closing = await connector.balance(link.external_account_id).catch(() => null);
    if (closing !== null) {
        const last = (await io.repo.latestClosings(io.workspaceId)).find((c) => c.account_id === link.account_id);
        const unchanged =
            last !== undefined &&
            Number(last.closing_balance) === closing.balance &&
            last.closing_date === closing.date;
        if (added > 0 || !unchanged) {
            const dates = lines.map((entry) => entry.date).sort();
            await io.repo.createImport(io.workspaceId, {
                accountId: link.account_id,
                format: 'bank',
                firstDate: dates[0] ?? null,
                lastDate: dates[dates.length - 1] ?? null,
                lineCount: lines.length,
                newCount: added,
                closingBalance: closing.balance,
                closingDate: closing.date
            });
        }
    }
    if (added > 0) await reconcileAccount(io, link.account_id);
    return added;
}
