import type { FinanceAccount, FinanceCategory, FinanceColor, FinanceConfig } from '@deveye/types';

/**
 * Le socle que tous les écrans des finances reçoivent.
 *
 * Réglages, comptes et catégories sont chargés **une fois** par la coquille
 * (`index.tsx`) et passés en propriété, plutôt que relus par chaque onglet.
 * Trois raisons: ils changent rarement, ils sont nécessaires partout (aucune
 * ligne du journal ne s'affiche sans le nom de son compte et la couleur de sa
 * catégorie), et surtout deux onglets qui les reliraient chacun de leur côté
 * pourraient les afficher différemment à la même seconde.
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

/**
 * Le jeton de thème d'une couleur nommée.
 *
 * Passe par une variable CSS et jamais par un hexadécimal en dur: c'est ce qui
 * fait qu'une catégorie suit les réglages du thème au lieu de jurer avec eux le
 * jour où la palette est retouchée.
 */
export function colorVar(color: FinanceColor): string {
    return `var(--finance-${color})`;
}

/** Le nom d'un compte, ou un repli lisible quand il a disparu. */
export function accountName(accounts: FinanceAccount[], id: number | null): string {
    return accountOf(accounts, id)?.name || 'Compte inconnu';
}
