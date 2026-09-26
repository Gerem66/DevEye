import { humanizeError, type ErrorNoteInput } from 'deveye-sdk-client';
import type {
    FinanceAccount,
    FinanceCategory,
    FinanceColor,
    FinanceConfig,
    FinanceTransactionKind
} from '../contracts/domain';

/**
 * Le socle chargé une fois par `Finance.tsx` et passé aux écrans : deux écrans
 * qui reliraient chacun pourraient afficher différemment à la même seconde.
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

/** Le sens d'un mouvement, tel que le lisent les montants colorés : un virement n'en a pas. */
export function flowOf(kind: FinanceTransactionKind): 'in' | 'out' | undefined {
    return kind === 'income' ? 'in' : kind === 'expense' ? 'out' : undefined;
}

/** Le signe qui précède un montant : plus pour une recette, moins pour une dépense, rien pour un virement. */
export function signOf(kind: FinanceTransactionKind): string {
    return kind === 'income' ? '+' : kind === 'expense' ? '\u2212' : '';
}

/** Un refus tel que le bandeau d'erreur du SDK le montre : la phrase, et son code pour le signalement. */
export function errorNote(e: unknown, fallback: string): ErrorNoteInput {
    const code = (e as { code?: unknown } | null)?.code;
    return { message: humanizeError(e, fallback), code: typeof code === 'string' ? code : null };
}
