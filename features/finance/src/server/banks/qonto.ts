import { STATEMENT_LABEL_MAX_LENGTH, type StatementLineInput } from '../../contracts/statement';
import { BankError, bankHttp, ibanEnd, MAX_PAGES, parisDay, parisToday, type BankConnector } from './types';

/**
 * Qonto, par la clé d'API de l'organisation (Qonto : Paramètres, Intégrations
 * et partenariats, Clé API). L'en-tête est `identifiant:clé`, pas du Basic.
 * Lecture seule : la clé ne permet ni virement ni modification.
 */

const API = 'https://thirdparty.qonto.com/v2';

export interface QontoSecret {
    login: string;
    secretKey: string;
}

interface QontoBankAccount {
    id: string;
    name?: string;
    iban?: string;
    currency?: string;
    status?: string;
    balance_cents?: number;
}

interface QontoTransaction {
    id: string;
    amount_cents: number;
    side: 'credit' | 'debit';
    label?: string | null;
    reference?: string | null;
    status?: string;
    settled_at?: string | null;
}

interface QontoPage {
    transactions: QontoTransaction[];
    meta?: { next_page?: number | null };
}

async function get<T>(secret: QontoSecret, path: string): Promise<T> {
    let res: Response;
    try {
        res = await bankHttp.fetch(`${API}${path}`, {
            headers: { Authorization: `${secret.login}:${secret.secretKey}`, Accept: 'application/json' }
        });
    } catch {
        throw new BankError('unavailable', 'Qonto ne répond pas.');
    }
    if (res.status === 401 || res.status === 403) {
        throw new BankError('auth', 'Qonto refuse cet identifiant et cette clé.');
    }
    if (!res.ok) throw new BankError('unavailable', `Qonto a répondu ${res.status}.`);
    return (await res.json()) as T;
}

export function qontoConnector(secret: QontoSecret): BankConnector {
    const organization = () =>
        get<{ organization: { bank_accounts?: QontoBankAccount[] } }>(secret, '/organization').then(
            (body) => body.organization.bank_accounts ?? []
        );

    return {
        async accounts() {
            return (await organization())
                .filter((account) => account.status !== 'closed')
                .map((account) => ({
                    id: account.id,
                    name: account.name ?? 'Compte Qonto',
                    ibanEnd: ibanEnd(account.iban),
                    currency: account.currency ?? 'EUR'
                }));
        },

        async transactions(accountId, since) {
            const lines: StatementLineInput[] = [];
            for (let page = 1; page <= MAX_PAGES; page++) {
                const query = new URLSearchParams({
                    bank_account_id: accountId,
                    'status[]': 'completed',
                    settled_at_from: `${since}T00:00:00.000Z`,
                    sort_by: 'settled_at:asc',
                    per_page: '100',
                    current_page: String(page)
                });
                const body = await get<QontoPage>(secret, `/transactions?${query.toString()}`);
                for (const t of body.transactions) {
                    const date = t.settled_at ? parisDay(t.settled_at) : null;
                    if (date === null || date < since || !t.amount_cents) continue;
                    const label = (t.label ?? '').trim();
                    const reference = (t.reference ?? '').trim();
                    lines.push({
                        date,
                        direction: t.side === 'credit' ? 'in' : 'out',
                        amount: Math.abs(t.amount_cents),
                        label: (label || reference).slice(0, STATEMENT_LABEL_MAX_LENGTH),
                        memo: label ? reference.slice(0, STATEMENT_LABEL_MAX_LENGTH) : '',
                        fitid: t.id.slice(0, 80)
                    });
                }
                if (!body.meta?.next_page) break;
            }
            return lines;
        },

        async balance(accountId) {
            const account = (await organization()).find((entry) => entry.id === accountId);
            if (account?.balance_cents === undefined) return null;
            return { balance: Math.round(account.balance_cents), date: parisToday() };
        }
    };
}
