import fc from 'fast-check';
import type { ZodType } from 'zod';

/**
 * Des valeurs qu'un schéma zod accepte, tirées de sa forme : de quoi éprouver
 * un protocole entier sans écrire un exemple par message. Rien n'est filtré
 * après coup, donc un type ou une contrainte que cette lecture ne connaît pas
 * lève ici, au lieu de tirer des valeurs que le schéma refuserait.
 */

interface Check {
    check?: string;
    minimum?: number;
    maximum?: number;
    length?: number;
    value?: number;
    inclusive?: boolean;
    format?: string;
    pattern?: RegExp;
}

interface Def extends Check {
    type: string;
    checks?: { _zod: { def: Check } }[];
    shape?: Record<string, ZodType>;
    innerType?: ZodType;
    in?: ZodType;
    out?: ZodType;
    element?: ZodType;
    options?: ZodType[];
    items?: ZodType[];
    keyType?: ZodType;
    valueType?: ZodType;
    values?: unknown[];
    entries?: Record<string, unknown>;
}

const defOf = (schema: ZodType): Def => (schema as unknown as { def: Def }).def;

/** Les contraintes d'un schéma : les siennes (`z.uuid()`), puis celles qu'on lui a chaînées. */
const checksOf = (def: Def): Check[] => [def, ...(def.checks ?? []).map((check) => check._zod.def)];

const KNOWN_CHECKS = new Set([
    undefined,
    'min_length',
    'max_length',
    'length_equals',
    'greater_than',
    'less_than',
    'number_format',
    'string_format'
]);

function assertKnown(def: Def): void {
    for (const check of checksOf(def)) {
        if (!KNOWN_CHECKS.has(check.check)) {
            throw new Error(`zod-arbitrary : contrainte « ${check.check} » non couverte (${def.type})`);
        }
    }
}

/** Les bornes de longueur d'une chaîne ou d'un tableau, sans dépasser `cap` quand le schéma ne l'exige pas. */
function lengthOf(def: Def, cap: number): { minLength: number; maxLength: number } {
    let min = 0;
    let max = cap;
    for (const check of checksOf(def)) {
        if (check.check === 'min_length') min = Math.max(min, check.minimum ?? 0);
        if (check.check === 'max_length') max = Math.min(max, check.maximum ?? max);
        if (check.check === 'length_equals') return { minLength: check.length ?? 0, maxLength: check.length ?? 0 };
    }
    return { minLength: min, maxLength: Math.max(min, max) };
}

/** Un caractère par unité UTF-16, comme zod compte les longueurs : surtout de l'ASCII, parfois au-delà. */
const codeUnit = fc
    .oneof(
        { weight: 3, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
        { weight: 1, arbitrary: fc.integer({ min: 0xa0, max: 0xd7ff }) }
    )
    .map((code) => String.fromCharCode(code));

function stringOf(def: Def): fc.Arbitrary<string> {
    const formats = checksOf(def).filter((check) => check.check === 'string_format');
    if (formats.length === 0) return fc.string({ ...lengthOf(def, 24), unit: codeUnit });
    const [format] = formats;
    if (formats.length > 1) throw new Error('zod-arbitrary : deux formats sur une même chaîne ne sont pas couverts');
    if (format.format === 'uuid') return fc.uuid({ version: 4 });
    if (!format.pattern) throw new Error(`zod-arbitrary : format de chaîne « ${format.format} » non couvert`);

    const { minLength, maxLength } = lengthOf(def, Infinity);
    const fits = (text: string): boolean => text.length >= minLength && text.length <= maxLength;
    const matching = fc.stringMatching(format.pattern);
    // Un filtre qui ne passe presque jamais tournerait sans fin : mieux vaut le dire ici.
    if (fc.sample(matching, 40).filter(fits).length < 10) {
        throw new Error(`zod-arbitrary : ${String(format.pattern)} donne trop peu de chaînes de la longueur voulue`);
    }
    return matching.filter(fits);
}

function numberOf(def: Def): fc.Arbitrary<number> {
    let min = -Infinity;
    let max = Infinity;
    let minExcluded = false;
    let maxExcluded = false;
    let integer = false;
    for (const check of checksOf(def)) {
        if (check.check === 'number_format') integer = true;
        if (check.check === 'greater_than' && (check.value ?? 0) >= min) {
            min = check.value ?? 0;
            minExcluded = check.inclusive === false;
        }
        if (check.check === 'less_than' && (check.value ?? 0) <= max) {
            max = check.value ?? 0;
            maxExcluded = check.inclusive === false;
        }
    }
    if (integer) {
        return fc.integer({
            min: Math.max(Math.ceil(min) + (minExcluded && Number.isInteger(min) ? 1 : 0), Number.MIN_SAFE_INTEGER),
            max: Math.min(Math.floor(max) - (maxExcluded && Number.isInteger(max) ? 1 : 0), Number.MAX_SAFE_INTEGER)
        });
    }
    return (
        fc
            .double({ min, max, minExcluded, maxExcluded, noNaN: true, noDefaultInfinity: true })
            // Le JSON n'a pas de zéro négatif : il reviendrait changé.
            .map((value) => (value === 0 ? 0 : value))
    );
}

export function arbitraryOf(schema: ZodType): fc.Arbitrary<unknown> {
    const def = defOf(schema);
    assertKnown(def);
    switch (def.type) {
        case 'string':
            return stringOf(def);
        case 'number':
            return numberOf(def);
        case 'boolean':
            return fc.boolean();
        case 'null':
            return fc.constant(null);
        case 'unknown':
        case 'any':
            return fc.jsonValue();
        case 'literal':
            return fc.constantFrom(...(def.values ?? []));
        case 'enum':
            return fc.constantFrom(...Object.values(def.entries ?? {}));
        case 'nullable':
            return fc.option(arbitraryOf(def.innerType as ZodType), { nil: null });
        // Absent ou présent se décide à l'objet qui porte le champ.
        case 'optional':
        case 'default':
        case 'catch':
        case 'readonly':
            return arbitraryOf(def.innerType as ZodType);
        // `z.preprocess` : ce qui convient au schéma d'arrivée traverse le prétraitement.
        case 'pipe':
            return arbitraryOf((defOf(def.in as ZodType).type === 'transform' ? def.out : def.in) as ZodType);
        case 'array':
            return fc.array(arbitraryOf(def.element as ZodType), lengthOf(def, 3));
        case 'tuple':
            return fc.tuple(...(def.items ?? []).map(arbitraryOf));
        case 'union':
            return fc.oneof(...(def.options ?? []).map(arbitraryOf));
        case 'record':
            return fc.dictionary(
                arbitraryOf(def.keyType as ZodType) as fc.Arbitrary<string>,
                arbitraryOf(def.valueType as ZodType),
                { maxKeys: 3 }
            );
        case 'object': {
            const fields = Object.entries(def.shape ?? {});
            return fc.record(Object.fromEntries(fields.map(([key, field]) => [key, arbitraryOf(field)])), {
                requiredKeys: fields.filter(([, field]) => !field.safeParse(undefined).success).map(([key]) => key)
            });
        }
        default:
            throw new Error(`zod-arbitrary : type « ${def.type} » non couvert`);
    }
}
