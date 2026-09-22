import type { FinanceAccount, FinanceCategory, FinanceColor, FinanceConfig } from '../contracts/domain';

/**
 * Le socle chargé une fois par `Finance.tsx` et passé aux onglets : deux
 * onglets qui reliraient chacun pourraient afficher différemment à la même
 * seconde.
 */
export interface FinanceBase {
    config: FinanceConfig;
    /** Tous les comptes de l'espace, archivés compris. */
    accounts: FinanceAccount[];
    categories: FinanceCategory[];
    /** Le droit d'écriture sur la feature. Le serveur revérifie de toute façon. */
    canWrite: boolean;
    /** Relit réglages, comptes et catégories. */
    reloadBase: () => void;
}

/** Les comptes qu'un sélecteur doit proposer: les vivants, dans leur ordre. */
export function activeAccounts(accounts: FinanceAccount[]): FinanceAccount[] {
    return accounts.filter((account) => !account.archived);
}

export function accountOf(accounts: FinanceAccount[], id: number | null): FinanceAccount | null {
    if (id === null) return null;
    return accounts.find((account) => account.id === id) ?? null;
}

export function categoryOf(categories: FinanceCategory[], id: number | null): FinanceCategory | null {
    if (id === null) return null;
    return categories.find((category) => category.id === id) ?? null;
}

/** Une variable CSS, jamais un hexadécimal : la catégorie suit le thème. */
export function colorVar(color: FinanceColor): string {
    return `var(--palette-${color})`;
}

/** Le nom d'un compte, ou un repli lisible quand il a disparu. */
export function accountName(accounts: FinanceAccount[], id: number | null): string {
    return accountOf(accounts, id)?.name || 'Compte inconnu';
}
