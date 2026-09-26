import type { BankRemoteAccount } from '../../contracts/banking';
import type { StatementClosing, StatementLineInput } from '../../contracts/statement';

/**
 * Ce qu'une connexion sait faire, quelle que soit la banque derrière : ses
 * comptes, leurs lignes passées au format d'un import, et leur solde. Tout ce
 * qu'elle rend passe ensuite par le même rapprochement qu'un fichier.
 */
export interface BankConnector {
    accounts(): Promise<BankRemoteAccount[]>;
    /** Les lignes comptabilisées depuis `since` (`AAAA-MM-JJ`), jamais celles encore en attente : elles changent. */
    transactions(accountId: string, since: string): Promise<StatementLineInput[]>;
    /** `null` quand la banque ne le donne pas. */
    balance(accountId: string): Promise<StatementClosing | null>;
}

/**
 * Un refus de la banque, rangé par ce qu'il demande à la personne. `auth` : les
 * accès sont refusés, il faut les corriger. `expired` : le consentement a pris
 * fin, il faut se reconnecter. `unavailable` : la banque ne répond pas, la
 * relève suivante réessaiera.
 */
export class BankError extends Error {
    constructor(
        readonly kind: 'auth' | 'expired' | 'unavailable',
        message: string
    ) {
        super(message);
        this.name = 'BankError';
    }
}

/** Au-delà, une relève s'arrête : un compte ne produit pas cent pages de lignes en six heures. */
export const MAX_PAGES = 50;

/** La couture des tests : le `fetch` des connecteurs, qu'un test remplace par un faux serveur. */
export const bankHttp: { fetch: (url: string, init?: RequestInit) => Promise<Response> } = {
    fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) })
};

/** Un montant décimal écrit par une API (`"1234.5"`, `-12.3`) en centimes, sans passer par un flottant arrondi de travers. */
export function centsOf(value: string | number): number | null {
    const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (match === null) return null;
    const [, sign, units, decimals = ''] = match;
    const cents = Number(units) * 100 + Math.round(Number(`0.${decimals || '0'}`) * 100);
    return sign === '-' ? -cents : cents;
}

/** Les quatre derniers caractères d'un IBAN, ce qui suffit à reconnaître un compte. */
export function ibanEnd(iban: string | null | undefined): string {
    const compact = (iban ?? '').replace(/\s+/g, '');
    return compact.length >= 4 ? compact.slice(-4) : '';
}

/** Le jour civil à Paris d'un instant ISO : un virement passé à 23 h 30 UTC appartient au lendemain. */
export function parisDay(iso: string): string | null {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(at);
}

export function parisToday(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}
