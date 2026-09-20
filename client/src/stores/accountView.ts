import { accountEntries } from '@/sdk/registry';
import { requestOpenView } from './viewRequest';

/** L'identifiant de vue de l'entrée de compte d'un module. */
export const accountViewId = (featureId: string): string => `account:${featureId}`;

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
