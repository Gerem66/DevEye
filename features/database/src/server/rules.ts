import type { DatabaseComparator, DatabaseCondition } from '../contracts/domain';

import { explainError, singleNumber, type Session } from './engine';

/**
 * L'évaluation d'une alerte, en fonctions pures : comparer une mesure à son
 * seuil, mesurer chaque condition, décider si l'alerte est franchie, rendre
 * son message. Le relevé périodique (`service.ts`) et l'essai à blanc
 * (`database.alertTest`) passent tous deux par ici, pour qu'une condition ne
 * puisse pas franchir d'un côté et pas de l'autre.
 */

/** L'issue d'une évaluation de condition : une valeur, ou la raison de son absence. */
export interface ConditionOutcome {
    value: number | null;
    error: string | null;
}

/** Compare une mesure à son seuil. */
export function compare(value: number, comparator: DatabaseComparator, threshold: number): boolean {
    switch (comparator) {
        case 'gt':
            return value > threshold;
        case 'gte':
            return value >= threshold;
        case 'lt':
            return value < threshold;
        case 'lte':
            return value <= threshold;
        case 'eq':
            return value === threshold;
        case 'ne':
            return value !== threshold;
        default:
            // Le `default` n'est pas décoratif : il rend la fonction totale pour
            // le compilateur tout en restant inatteignable, l'entrée étant
            // validée par `databaseComparatorSchema`.
            return false;
    }
}

/**
 * Évalue chaque condition sur une session ouverte.
 *
 * Une condition en échec **n'interrompt pas** les autres : on veut voir d'un
 * coup d'œil laquelle des cinq est mal écrite, pas découvrir la deuxième après
 * avoir corrigé la première.
 */
export async function runConditions(
    session: Pick<Session, 'query'>,
    conditions: DatabaseCondition[]
): Promise<ConditionOutcome[]> {
    const out: ConditionOutcome[] = [];
    for (const condition of conditions) {
        try {
            out.push({ value: singleNumber(await session.query(condition.sql)), error: null });
        } catch (e) {
            out.push({ value: null, error: explainError(e) });
        }
    }
    return out;
}

/**
 * L'alerte est-elle franchie ?
 *
 * Une condition qui n'a pas pu être mesurée **ne franchit pas** : en `and` elle
 * empêche le déclenchement, en `or` elle ne l'entraîne pas. Le contraire ferait
 * d'une requête mal écrite une source d'alertes permanentes, ce qui est la
 * meilleure façon de faire ignorer un canal d'alerte.
 */
export function isFiring(
    conditions: DatabaseCondition[],
    outcomes: ConditionOutcome[],
    combinator: 'and' | 'or'
): boolean {
    const met = conditions.map((condition, i) => {
        const outcome = outcomes[i];
        if (!outcome || outcome.value === null) return false;
        return compare(outcome.value, condition.comparator, condition.threshold);
    });
    return combinator === 'and' ? met.every(Boolean) : met.some(Boolean);
}

/** Remplace `{label}` par la valeur mesurée de la condition portant ce nom. */
export function renderMessage(message: string, conditions: DatabaseCondition[], outcomes: ConditionOutcome[]): string {
    return message.replace(/\{([^{}]{1,96})\}/g, (whole, label: string) => {
        const i = conditions.findIndex((c) => c.label === label);
        if (i === -1) return whole;
        const value = outcomes[i]?.value;
        return value === null || value === undefined ? '—' : String(value);
    });
}
