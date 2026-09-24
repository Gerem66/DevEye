import { accountEntries } from '@/sdk/registry';
import { requestOpenView } from './viewRequest';

const ACCOUNT_VIEW_PREFIX = 'account:';

/** L'identifiant de vue de l'entrée de compte d'un module. */
export const accountViewId = (featureId: string): string => `${ACCOUNT_VIEW_PREFIX}${featureId}`;

/** Le module derrière une vue de compte, ou `null` pour une autre vue. */
export const accountViewFeature = (viewId: string): string | null =>
    viewId.startsWith(ACCOUNT_VIEW_PREFIX) ? viewId.slice(ACCOUNT_VIEW_PREFIX.length) : null;

const hints = new Map<string, string>();

/**
 * Ouvre la vue de compte d'un module (`manifest.accountEntry`) : sans
 * `featureId`, la première installée, et sans aucune, rien. `hint` attend la
 * vue, qui le lit une fois à son montage.
 */
export function openAccountView(featureId?: string, hint?: string): void {
    const target = featureId ?? accountEntries()[0]?.manifest.id;
    if (!target) return;
    if (hint) hints.set(target, hint);
    requestOpenView(accountViewId(target));
}

export function takeAccountViewHint(featureId: string): string | undefined {
    const hint = hints.get(featureId);
    hints.delete(featureId);
    return hint;
}
