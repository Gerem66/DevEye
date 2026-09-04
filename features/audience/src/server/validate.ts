import {
    AUDIENCE_FIELD_VALUE_MAX_LENGTH,
    AUDIENCE_FIELD_VALUES_MAX,
    type AudienceFieldValue,
    type AudienceFormField
} from '../contracts/domain';

/**
 * La confrontation d'un envoi aux champs déclarés d'un formulaire.
 *
 * Tout ici est pur : aucune base, aucun réseau, aucune horloge. Deux rôles,
 * indissociables :
 *
 * 1. **refuser** ce qui ne colle pas au schéma, pour qu'un inconnu qui a la clé
 *    publique ne décide pas de ce que l'écran affiche ;
 * 2. **convertir**, ce qui est la moitié qu'on oublie. Un `<form>` HTML
 *    n'envoie que des chaînes : `"4"` pour un nombre, `"on"` pour une case
 *    cochée, et rien du tout pour une case décochée. Sans le type déclaré, la
 *    même réponse compterait pour deux valeurs distinctes selon la porte par
 *    laquelle elle est entrée.
 *
 * Ce que cette fonction rend est donc ce qui sera **rangé et compté** :
 * `indexableAnswers` voit la valeur convertie, jamais la chaîne d'origine.
 */

/** Ce qui cloche, nommé, pour que le site puisse se corriger. */
export type ValidationReason = 'unknown' | 'missing' | 'type' | 'choice' | 'tooLong';

export type ValidationResult =
    { ok: true; fields: Record<string, AudienceFieldValue> } | { ok: false; field: string; reason: ValidationReason };

/** `"on"` est ce qu'envoie une case cochée d'un formulaire HTML. */
const TRUE_WORDS = new Set(['true', 'on', 'oui', 'yes', '1']);
const FALSE_WORDS = new Set(['false', 'off', 'non', 'no', '0', '']);

/**
 * Une adresse plausible, pas une adresse valide : la seule vérification qui
 * vaille est l'envoi d'un message. On écarte les fautes de frappe grossières
 * sans prétendre trancher ce que la RFC 5322 laisse ouvert.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function validateSubmission(
    fields: readonly AudienceFormField[],
    input: Record<string, AudienceFieldValue>
): ValidationResult {
    const declared = new Map(fields.map((field) => [field.name, field]));

    // Un champ que le formulaire ne connaît pas fait tout refuser, plutôt que
    // d'être jeté en silence : le site vient de renommer quelque chose, et
    // l'accepter à moitié rendrait la perte invisible des deux côtés.
    for (const name of Object.keys(input)) {
        if (!declared.has(name)) return { ok: false, field: name, reason: 'unknown' };
    }

    const out: Record<string, AudienceFieldValue> = {};
    for (const field of fields) {
        const raw = input[field.name];
        const absent = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);

        if (absent) {
            if (field.required) return { ok: false, field: field.name, reason: 'missing' };
            // Une question posée et non remplie reste une question posée : elle
            // entre à `null` pour que le dénombrement la compte, plutôt que de
            // disparaître de la ligne.
            out[field.name] = null;
            continue;
        }

        const converted = convert(field, raw);
        if (converted === undefined) {
            return { ok: false, field: field.name, reason: field.kind === 'choice' ? 'choice' : 'type' };
        }
        if (typeof converted === 'string' && converted.length > AUDIENCE_FIELD_VALUE_MAX_LENGTH) {
            return { ok: false, field: field.name, reason: 'tooLong' };
        }
        out[field.name] = converted;
    }
    return { ok: true, fields: out };
}

/** La valeur telle qu'on la rangera, ou `undefined` si elle ne colle pas. */
function convert(field: AudienceFormField, raw: AudienceFieldValue): AudienceFieldValue | undefined {
    if (field.kind === 'choice') {
        const picked = (Array.isArray(raw) ? raw : [raw]).map((one) => String(one).trim());
        if (!field.multiple && picked.length > 1) return undefined;
        if (picked.length > AUDIENCE_FIELD_VALUES_MAX) return undefined;
        if (picked.some((one) => !field.choices.includes(one))) return undefined;
        return field.multiple ? picked : picked[0];
    }

    // Au-delà, ce n'est plus une réponse à une question simple : un tableau ne
    // se range que derrière un champ à choix multiples.
    if (Array.isArray(raw)) return undefined;

    if (field.kind === 'number') {
        // La virgule décimale est ce que tape un francophone dans un champ
        // libre ; la refuser ferait échouer l'envoi sur une convention d'écriture.
        const value = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
        return Number.isFinite(value) ? value : undefined;
    }

    if (field.kind === 'boolean') {
        if (typeof raw === 'boolean') return raw;
        const word = String(raw).trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return true;
        if (FALSE_WORDS.has(word)) return false;
        return undefined;
    }

    const text = String(raw).trim();
    if (field.kind === 'email') return EMAIL.test(text) ? text.toLowerCase() : undefined;
    return text;
}
