import {
    AUDIENCE_ANSWER_VALUE_MAX_LENGTH,
    AUDIENCE_ANSWER_VALUES_MAX,
    AUDIENCE_FIELD_NAME_MAX_LENGTH,
    type AudienceFieldValue
} from '../contracts/domain';
import type { SdkCipher } from '@deveye/types/sdk/server';

import { labelRef } from './normalize';
import type { AudienceFormsRepo } from './repoForms';

/**
 * Ce qu'on compte dans un retour, et ce qu'on renonce à compter.
 *
 * Les règles (`indexableAnswers`) sont pures, et l'écriture qui les applique
 * (`countAnswers`) est juste en dessous : la réception incrémente, la
 * suppression décrémente, et les deux doivent passer par exactement les mêmes
 * décisions. Les séparer de fichier serait la meilleure façon de les faire
 * diverger, ce que rien ne signalerait, les compteurs se contentant de dériver.
 */

/** Une réponse à ranger : sa question, et sa valeur ou le seau. */
export interface IndexableAnswer {
    field: string;
    /** `null` = seau « texte libre » : reçue et comptée, valeur non indexée. */
    value: string | null;
}

/**
 * Comment une valeur se compare à une autre. Un nombre et sa forme textuelle
 * doivent tomber sur la même ligne de répartition : un formulaire HTML envoie
 * `"4"`, un appel JSON envoie `4`, et c'est la même réponse.
 */
function canonical(value: string | number | boolean): string {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return value.trim();
}

/**
 * Les couples (question, réponse) d'un retour.
 *
 * Un tableau donne une entrée par élément : c'est une question à choix
 * multiples, et compter `["a","b"]` comme une valeur unique ferait autant de
 * lignes de répartition que de combinaisons cochées.
 *
 * Une valeur vide ou plus longue que {@link AUDIENCE_ANSWER_VALUE_MAX_LENGTH}
 * tombe dans le seau : compter les occurrences d'un message de contact ne dirait
 * rien et ferait une ligne de dimension par visiteur.
 */
export function indexableAnswers(fields: Record<string, AudienceFieldValue>): IndexableAnswer[] {
    const out: IndexableAnswer[] = [];
    for (const [rawName, raw] of Object.entries(fields)) {
        const field = rawName.trim().slice(0, AUDIENCE_FIELD_NAME_MAX_LENGTH);
        if (!field) continue;

        // Une réponse absente ne dit rien, mais la question a bien été posée : elle
        // compte au seau plutôt que de disparaître du dénombrement.
        const values: (string | number | boolean)[] = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
        if (values.length === 0) {
            out.push({ field, value: null });
            continue;
        }

        for (const item of values) {
            const value = canonical(item);
            out.push({ field, value: value && value.length <= AUDIENCE_ANSWER_VALUE_MAX_LENGTH ? value : null });
        }
    }
    return out;
}

/**
 * Incrémente (`delta = 1`) ou décrémente (`-1`) la répartition d'un retour.
 *
 * Les compteurs sont tenus à l'écriture plutôt que calculés à la lecture : la
 * charge utile est chiffrée, un `GROUP BY` dessus est impossible par
 * construction. Une fonction et non une méthode du service : la suppression
 * d'un retour n'a aucune raison de dépendre d'une file en mémoire, et un
 * service absent ne doit pas laisser passer une ligne effacée sans la décompter.
 */
export async function countAnswers(
    repo: AudienceFormsRepo,
    cipher: SdkCipher,
    formId: number,
    fields: Record<string, AudienceFieldValue>,
    delta: 1 | -1
): Promise<void> {
    /** Les questions déjà résolues dans ce retour : un choix multiple répète la sienne. */
    const fieldIds = new Map<string, number>();

    for (const answer of indexableAnswers(fields)) {
        let fieldId = fieldIds.get(answer.field);
        if (fieldId === undefined) {
            fieldId = await repo.resolveFormLabel(
                formId,
                'field',
                labelRef(answer.field),
                await cipher.encrypt(answer.field)
            );
            fieldIds.set(answer.field, fieldId);
        }

        // 0 = le seau « texte libre ».
        let valueId = 0;
        if (answer.value !== null) {
            const ref = labelRef(answer.value);
            const known = await repo.findFormLabel(formId, 'value', ref);
            if (known !== null) {
                valueId = known;
            } else if (delta > 0 && (await repo.countAnswerValues(formId, fieldId)) < AUDIENCE_ANSWER_VALUES_MAX) {
                valueId = await repo.resolveFormLabel(formId, 'value', ref, await cipher.encrypt(answer.value));
            }
            // Dépassement de cardinalité : la question n'était pas fermée, elle
            // bascule au seau. Une suppression retombe sur le même seau, faute de
            // libellé, ce qui reproduit la décision prise à la réception.
        }
        await repo.bumpAnswer(formId, fieldId, valueId, delta);
    }
}
