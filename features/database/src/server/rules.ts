import type { DatabaseComparator, DatabaseCondition } from '../contracts/domain';

import { explainError, singleNumber, type Session } from './engine';

/**
 * L'évaluation d'une alerte, en fonctions pures, partagées par le relevé
 * périodique et l'essai à blanc.
 */

/** Une valeur, ou la raison de son absence. */
export interface ConditionOutcome {
    value: number | null;
    error: string | null;
}

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
            // Inatteignable, l'entrée étant validée par `databaseComparatorSchema`.
            return false;
    }
}

/** Évalue chaque condition ; une condition en échec n'interrompt pas les autres. */
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
 * Une condition non mesurée ne franchit pas (en `and` elle empêche, en `or`
 * elle n'entraîne pas) : une requête mal écrite ne doit pas alerter en permanence.
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
