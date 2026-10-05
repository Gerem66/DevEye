import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

import type { BankInstitution, BankPsuType, BankRemoteAccount } from '../../contracts/banking';
import { STATEMENT_LABEL_MAX_LENGTH, type StatementLineInput } from '../../contracts/statement';
import { env } from '../env';
import { BankError, bankHttp, centsOf, ibanEnd, MAX_PAGES, parisToday, type BankConnector } from './types';

/**
 * Enable Banking : un agrégateur agréé qui ouvre les comptes de la plupart des
 * banques européennes par le consentement de leur titulaire (DSP2). Chaque
 * appel se signe d'un jeton RS256 fait avec la clé de l'application ; le
 * titulaire consent chez sa banque, qui le renvoie ici avec un code, échangé
 * contre une session valable jusqu'à une date que la banque fixe.
 */

const API = 'https://api.enablebanking.com';

export interface EnableBankingApp {
    appId: string;
    key: KeyObject;
}

/** Ce qu'une connexion Enable Banking garde, chiffré. */
export interface EnableBankingSecret {
    sessionId: string;
}

/** Un compte de la session, avec ce qui le reconnaît d'une session à la suivante. */
export interface EnableBankingAccount extends BankRemoteAccount {
    /** `identification_hash` : stable quand la banque renouvelle le consentement, contrairement à l'identifiant. */
    key: string;
}

let cached: { signature: string; app: EnableBankingApp | null } | null = null;

function readKey(raw: string): KeyObject | null {
    const pem = raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
    try {
        return createPrivateKey(pem);
    } catch {
        return null;
    }
}

/** L'application de l'instance, `null` quand elle n'est pas configurée ou que sa clé ne se lit pas. */
export function enableBankingApp(): EnableBankingApp | null {
    const appId = env.ENABLE_BANKING_APP_ID.trim();
    const raw = env.ENABLE_BANKING_PRIVATE_KEY.trim();
    if (appId === '' || raw === '') return null;
    const signature = `${appId}|${raw}`;
    if (cached?.signature !== signature) {
        const key = readKey(raw);
        cached = { signature, app: key === null ? null : { appId, key } };
    }
    return cached.app;
}

/** Ce qui cloche dans la configuration, pour l'avertissement du démarrage. `null` : rien, ou rien de demandé. */
export function enableBankingProblem(): string | null {
    const appId = env.ENABLE_BANKING_APP_ID.trim();
    const raw = env.ENABLE_BANKING_PRIVATE_KEY.trim();
    if (appId === '' && raw === '') return null;
    if (appId === '') return 'ENABLE_BANKING_PRIVATE_KEY est posée sans ENABLE_BANKING_APP_ID';
    if (raw === '') return 'ENABLE_BANKING_APP_ID est posée sans ENABLE_BANKING_PRIVATE_KEY';
    return readKey(raw) === null ? 'ENABLE_BANKING_PRIVATE_KEY ne se lit pas comme une clé privée PEM' : null;
}

function base64url(value: string): string {
    return Buffer.from(value).toString('base64url');
}

function token(app: EnableBankingApp): string {
    const iat = Math.floor(Date.now() / 1000);
    const head = base64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: app.appId }));
    const body = base64url(
        JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 })
    );
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(app.key, 'base64url');
    return `${head}.${body}.${signature}`;
}

async function call<T>(
    app: EnableBankingApp,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
): Promise<T> {
    let res: Response;
    try {
        res = await bankHttp.fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token(app)}`,
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
    } catch {
        throw new BankError('unavailable', 'Enable Banking ne répond pas.');
    }
    if (res.ok) return (res.status === 204 ? {} : await res.json()) as T;
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
        throw new BankError('auth', 'Enable Banking refuse l’application de ce serveur : prévenez son administrateur.');
    }
    if (res.status === 403 || /EXPIRED|REVOKED|ACCESS_DENIED|CLOSED/i.test(detail)) {
        throw new BankError('expired', 'Le consentement donné à la banque a pris fin : reconnectez-la.');
    }
    throw new BankError('unavailable', `Enable Banking a répondu ${res.status}.`);
}

/** Ce qu'Enable Banking dit de l'application de l'instance ; lève comme tout appel. */
export async function describeApplication(
    app: EnableBankingApp
): Promise<{ name: string | null; environment: string | null; active: boolean | null }> {
    const body = await call<{ name?: string; environment?: string; active?: boolean }>(app, 'GET', '/application');
    return { name: body.name ?? null, environment: body.environment ?? null, active: body.active ?? null };
}

interface Aspsp {
    name: string;
    country: string;
    psu_types?: string[];
    maximum_consent_validity?: number;
}

/** Les banques d'un pays, et la plus longue durée de consentement que chacune accepte (secondes). */
export async function listBanks(
    app: EnableBankingApp,
    country: string
): Promise<(BankInstitution & { maxConsentSeconds: number | null })[]> {
    const body = await call<{ aspsps?: Aspsp[] }>(app, 'GET', `/aspsps?country=${encodeURIComponent(country)}`);
    return (body.aspsps ?? []).map((aspsp) => ({
        name: aspsp.name,
        country: aspsp.country,
        psuTypes: (aspsp.psu_types ?? ['personal']).filter(
            (type): type is BankPsuType => type === 'business' || type === 'personal'
        ),
        maxConsentSeconds: aspsp.maximum_consent_validity ?? null
    }));
}

/** L'adresse où la personne consent chez sa banque. `state` revient tel quel avec le code. */
export async function startAuthorization(
    app: EnableBankingApp,
    input: {
        bank: string;
        country: string;
        psuType: BankPsuType;
        state: string;
        redirectUrl: string;
        validUntil: number;
    }
): Promise<string> {
    const body = await call<{ url: string }>(app, 'POST', '/auth', {
        access: { valid_until: new Date(input.validUntil * 1000).toISOString() },
        aspsp: { name: input.bank, country: input.country },
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: input.psuType,
        language: 'fr'
    });
    return body.url;
}

interface SessionAccount {
    uid: string;
    name?: string | null;
    currency?: string | null;
    account_id?: { iban?: string | null } | null;
    identification_hash?: string | null;
}

/** Échange le code du retour contre une session, ses comptes et la fin du consentement. */
export async function openSession(
    app: EnableBankingApp,
    code: string
): Promise<{ sessionId: string; validUntil: number | null; accounts: EnableBankingAccount[] }> {
    const body = await call<{
        session_id: string;
        accounts?: SessionAccount[];
        access?: { valid_until?: string | null };
    }>(app, 'POST', '/sessions', { code });
    const until = body.access?.valid_until ? Date.parse(body.access.valid_until) : Number.NaN;
    return {
        sessionId: body.session_id,
        validUntil: Number.isNaN(until) ? null : Math.floor(until / 1000),
        accounts: (body.accounts ?? []).map((account) => ({
            id: account.uid,
            name: account.name ?? 'Compte',
            ibanEnd: ibanEnd(account.account_id?.iban),
            currency: account.currency ?? 'EUR',
            key: account.identification_hash ?? account.account_id?.iban ?? account.uid
        }))
    };
}

/** Au mieux : une session déjà close chez l'agrégateur ne retient pas un retrait. */
export async function closeSession(app: EnableBankingApp, sessionId: string): Promise<void> {
    await call(app, 'DELETE', `/sessions/${encodeURIComponent(sessionId)}`).catch(() => undefined);
}

interface EbTransaction {
    entry_reference?: string | null;
    transaction_id?: string | null;
    transaction_amount: { amount: string; currency?: string };
    credit_debit_indicator: 'CRDT' | 'DBIT';
    status?: string | null;
    booking_date?: string | null;
    value_date?: string | null;
    transaction_date?: string | null;
    creditor?: { name?: string | null } | null;
    debtor?: { name?: string | null } | null;
    remittance_information?: string[] | null;
}

/** Les soldes par ordre de préférence : le comptabilisé de clôture d'abord, le disponible en dernier. */
const BALANCE_TYPES = ['CLBD', 'ITBD', 'XPCD', 'CLAV', 'ITAV', 'OPBD'];

/** Les comptes se lisent par leur identifiant de session ; la session elle-même ne sert qu'à se rendre. */
export function enableBankingConnector(app: EnableBankingApp, accounts: readonly BankRemoteAccount[]): BankConnector {
    return {
        async accounts() {
            return [...accounts];
        },

        async transactions(accountId, since) {
            const lines: StatementLineInput[] = [];
            let continuation: string | null = null;
            for (let page = 0; page < MAX_PAGES; page++) {
                const query = new URLSearchParams({ date_from: since, transaction_status: 'BOOK' });
                if (continuation !== null) query.set('continuation_key', continuation);
                const body: { transactions?: EbTransaction[]; continuation_key?: string | null } = await call(
                    app,
                    'GET',
                    `/accounts/${encodeURIComponent(accountId)}/transactions?${query.toString()}`
                );
                for (const t of body.transactions ?? []) {
                    if (t.status && t.status !== 'BOOK') continue;
                    const date = t.booking_date ?? t.value_date ?? t.transaction_date ?? null;
                    const amount = centsOf(t.transaction_amount.amount);
                    if (date === null || date < since || amount === null || amount === 0) continue;
                    const incoming = t.credit_debit_indicator === 'CRDT';
                    const name = ((incoming ? t.debtor?.name : t.creditor?.name) ?? '').trim();
                    const remittance = (t.remittance_information ?? []).join(' ').replace(/\s+/g, ' ').trim();
                    const fitid = t.entry_reference || t.transaction_id || null;
                    lines.push({
                        date: date.slice(0, 10),
                        direction: incoming ? 'in' : 'out',
                        amount: Math.abs(amount),
                        label: (name || remittance).slice(0, STATEMENT_LABEL_MAX_LENGTH),
                        memo: name ? remittance.slice(0, STATEMENT_LABEL_MAX_LENGTH) : '',
                        fitid: fitid === null ? null : fitid.slice(0, 80)
                    });
                }
                continuation = body.continuation_key ?? null;
                if (continuation === null || continuation === '') break;
            }
            return lines;
        },

        async balance(accountId) {
            const body = await call<{
                balances?: {
                    balance_amount: { amount: string };
                    balance_type?: string;
                    reference_date?: string | null;
                }[];
            }>(app, 'GET', `/accounts/${encodeURIComponent(accountId)}/balances`);
            const balances = body.balances ?? [];
            const rank = (type: string | undefined) => {
                const index = BALANCE_TYPES.indexOf(type ?? '');
                return index === -1 ? BALANCE_TYPES.length : index;
            };
            const best = [...balances].sort((a, b) => rank(a.balance_type) - rank(b.balance_type))[0];
            const cents = best ? centsOf(best.balance_amount.amount) : null;
            if (!best || cents === null) return null;
            return { balance: cents, date: best.reference_date?.slice(0, 10) || parisToday() };
        }
    };
}
