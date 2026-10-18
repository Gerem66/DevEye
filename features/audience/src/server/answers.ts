import {
    AUDIENCE_ANSWER_VALUE_MAX_LENGTH,
    AUDIENCE_ANSWER_FIELDS_MAX,
    AUDIENCE_ANSWER_VALUES_MAX,
    AUDIENCE_FIELD_NAME_MAX_LENGTH,
    type AudienceFieldKind,
    type AudienceFieldValue,
    type AudienceFormField
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

/**
 * Le type déclaré d'une question, `null` quand le formulaire ne la déclare pas
 * (mode `auto`, ou question inconnue du schéma).
 */
export type KindOf = (field: string) => AudienceFieldKind | null;

/** Les types dont une valeur est une statistique, jamais une donnée de personne. */
const STATISTICAL_KINDS: ReadonlySet<AudienceFieldKind> = new Set(['choice', 'boolean', 'number']);

/** Le lecteur de types d'un schéma déclaré ; vide, chaque question est inconnue. */
export function kindsOf(fields: readonly AudienceFormField[]): KindOf {
    const kinds = new Map(fields.map((field) => [field.name, field.kind]));
    return (field) => kinds.get(field) ?? null;
}

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
 * rien et ferait une ligne de dimension par visiteur. Une question déclarée en
 * texte ou en e-mail y tombe toujours : un nom, une adresse ne sont pas des
 * statistiques, et ne doivent pas survivre au retour qui les porte.
 */
export function indexableAnswers(fields: Record<string, AudienceFieldValue>, kindOf?: KindOf): IndexableAnswer[] {
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

        const kind = kindOf?.(field) ?? null;
        const personal = kind !== null && !STATISTICAL_KINDS.has(kind);
        for (const item of values) {
            const value = canonical(item);
            const indexed = !personal && value && value.length <= AUDIENCE_ANSWER_VALUE_MAX_LENGTH;
            out.push({ field, value: indexed ? value : null });
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
 *
 * `kindOf` ne sert qu'à la réception. La décrémentation suit ce qui a été écrit,
 * pas le schéma du jour : une valeur gardée se retire, les autres sortent du
 * seau, et une valeur retombée à zéro part avec son libellé.
 */
export async function countAnswers(
    repo: AudienceFormsRepo,
    cipher: SdkCipher,
    formId: number,
    fields: Record<string, AudienceFieldValue>,
    delta: 1 | -1,
    kindOf?: KindOf
): Promise<void> {
    /** Les questions déjà résolues dans ce retour : un choix multiple répète la sienne. */
    const fieldIds = new Map<string, number>();

    for (const answer of indexableAnswers(fields, delta > 0 ? kindOf : undefined)) {
        let fieldId = fieldIds.get(answer.field);
        if (fieldId === undefined) {
            // En décrémentation on ne crée rien : le libellé d'une question vidée
            // entre-temps n'a pas à renaître pour qu'on retire un compte qui
            // n'existe plus. Absent, il n'y a simplement rien à défaire.
            const ref = labelRef(answer.field);
            let found = await repo.findFormLabel(formId, 'field', ref);
            if (found === null && delta > 0) {
                // Le nombre de questions n'était borné que sur un formulaire
                // déclaré. En mode `auto`, chaque envoi pouvait en apporter
                // quarante inédites, et la table des libellés grossissait au
                // rythme du quota horaire, sans rétention pour la vider.
                if ((await repo.countAnswerFields(formId)) >= AUDIENCE_ANSWER_FIELDS_MAX) continue;
                found = await repo.resolveFormLabel(formId, 'field', ref, await cipher.encrypt(answer.field));
            }
            if (found === null) continue;
            fieldId = found;
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
        if (delta < 0 && valueId !== 0) await repo.dropAnswerIfEmpty(formId, fieldId, valueId);
    }
}

/**
 * Ce qu'un retour expiré laisse aux résultats : les comptes, jamais ce qu'une
 * personne a écrit. Les valeurs d'une question à choix, oui-non ou nombre
 * restent comptées, les totaux de chaque question aussi. Une valeur gardée
 * pour une question non déclarée (un nom tapé dans un formulaire `auto`) passe
 * au seau « texte libre », et son libellé part quand plus rien ne la cite.
 */
export async function expireAnswers(
    repo: AudienceFormsRepo,
    formId: number,
    fields: Record<string, AudienceFieldValue>,
    kindOf: KindOf
): Promise<void> {
    for (const answer of indexableAnswers(fields)) {
        if (answer.value === null) continue;
        const kind = kindOf(answer.field);
        if (kind !== null && STATISTICAL_KINDS.has(kind)) continue;
        const [fieldId, valueId] = await Promise.all([
            repo.findFormLabel(formId, 'field', labelRef(answer.field)),
            repo.findFormLabel(formId, 'value', labelRef(answer.value))
        ]);
        // Sans libellé, la réponse a été comptée au seau : elle y reste.
        if (fieldId === null || valueId === null) continue;
        await repo.bumpAnswer(formId, fieldId, valueId, -1);
        await repo.dropAnswerIfEmpty(formId, fieldId, valueId);
        await repo.bumpAnswer(formId, fieldId, 0, 1);
    }
}
