import { z } from 'zod';

/**
 * Les réglages d'une conversion, dits une fois : l'étape « Options » rend un
 * contrôle par entrée, le serveur relit les mêmes entrées pour composer ses
 * arguments. Ni l'un ni l'autre ne connaît un format.
 */

export const sizeValueSchema = z.object({
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    /** Vrai : l'image tient dans ces dimensions sans se déformer. Faux : elle est étirée pour les remplir exactement. */
    keepRatio: z.boolean().default(true)
});
export type SizeValue = z.infer<typeof sizeValueSchema>;

/**
 * Ce qu'on retire de chaque bord, en pixels de la source. Des marges et non un
 * rectangle : elles se règlent sans connaître les dimensions du fichier, que le
 * navigateur ne sait pas toujours lire, et le serveur les applique aux vraies.
 */
export const cropValueSchema = z.object({
    top: z.number().int().nonnegative(),
    right: z.number().int().nonnegative(),
    bottom: z.number().int().nonnegative(),
    left: z.number().int().nonnegative()
});
export type CropValue = z.infer<typeof cropValueSchema>;

export const optionValueSchema = z.union([
    z.number(),
    z.string().max(64),
    z.boolean(),
    z.null(),
    sizeValueSchema,
    cropValueSchema
]);
export type OptionValue = z.infer<typeof optionValueSchema>;

export const optionValuesSchema = z.record(z.string().max(32), optionValueSchema);
export type OptionValues = z.infer<typeof optionValuesSchema>;

export type OptionSection = 'quality' | 'picture' | 'sound' | 'trim' | 'privacy';

/**
 * Les rubriques de l'étape « Options », dans l'ordre où elles se présentent.
 * `quiet` : ce qu'on ne touche que rarement s'efface tant qu'on n'y a rien
 * changé, pour laisser l'œil sur l'essentiel, et offre d'y revenir une fois touché.
 */
export const OPTION_SECTIONS: readonly { id: OptionSection; label: string; quiet?: boolean }[] = [
    { id: 'quality', label: 'Qualité et poids' },
    { id: 'picture', label: 'Image', quiet: true },
    { id: 'sound', label: 'Son' },
    { id: 'trim', label: 'Passage à garder' },
    { id: 'privacy', label: 'Confidentialité' }
];

export interface OptionCondition {
    option: string;
    equals: string | boolean;
}

interface OptionBase {
    id: string;
    label: string;
    section: OptionSection;
    /** Deux réglages qui vont par paire (début et fin) se partagent une ligne. */
    half?: boolean;
    /** Une phrase pour quelqu'un qui débute, sous le contrôle. */
    hint?: string;
    /**
     * Le réglage n'apparaît, et ne compte, que si un autre a cette valeur ; tous,
     * quand il y en a plusieurs. Un réglage dont dépend un autre se déclare avant lui.
     */
    when?: OptionCondition | readonly OptionCondition[];
}

export type OptionSpec =
    | (OptionBase & {
          kind: 'slider';
          min: number;
          max: number;
          step: number;
          default: number;
          unit?: string;
          /** Repères sous la piste, de gauche à droite. */
          marks?: readonly string[];
          /** Une valeur de référence à marquer sur la piste, propre au fichier choisi. */
          indicator?: number;
          /**
           * Ce que la valeur se lit : par défaut elle-même et son unité.
           * `scaledDims` : un pourcentage des dimensions de l'image, qui s'affichent avec lui.
           */
          readout?: 'scaledDims';
      })
    | (OptionBase & {
          kind: 'segments';
          /** `detail` : ce que le choix vaut pour CE fichier, en petit sous son libellé. */
          options: readonly { value: string; label: string; detail?: string }[];
          default: string;
      })
    | (OptionBase & { kind: 'toggle'; default: boolean })
    /** `null` : laissé tel quel. */
    | (OptionBase & { kind: 'number'; min: number; max: number; step: number; unit?: string })
    /** Les dimensions du résultat, proportions gardées ou non. `null` : inchangé. */
    | (OptionBase & { kind: 'size' })
    | (OptionBase & { kind: 'crop' })
    /** Une taille de fichier, en octets. */
    | (OptionBase & { kind: 'bytes'; default: number });

export const EMPTY_SIZE: SizeValue = { width: null, height: null, keepRatio: true };

export function defaultOf(spec: OptionSpec): OptionValue {
    switch (spec.kind) {
        case 'slider':
        case 'segments':
        case 'toggle':
        case 'bytes':
            return spec.default;
        case 'size':
            return EMPTY_SIZE;
        case 'number':
        case 'crop':
            return null;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** La valeur reçue si elle convient au réglage, son défaut sinon. Jamais d'erreur : un réglage illisible ne bloque pas une conversion. */
function coerce(spec: OptionSpec, value: OptionValue | undefined): OptionValue {
    switch (spec.kind) {
        case 'slider':
            return typeof value === 'number' && Number.isFinite(value)
                ? clamp(value, spec.min, spec.max)
                : spec.default;
        case 'number':
            return typeof value === 'number' && Number.isFinite(value) ? clamp(value, spec.min, spec.max) : null;
        case 'segments':
            return spec.options.some((o) => o.value === value) ? (value as string) : spec.default;
        case 'toggle':
            return typeof value === 'boolean' ? value : spec.default;
        case 'bytes':
            return typeof value === 'number' && value > 0 ? Math.floor(value) : spec.default;
        case 'size': {
            const parsed = sizeValueSchema.safeParse(value);
            return parsed.success ? parsed.data : EMPTY_SIZE;
        }
        case 'crop': {
            const parsed = cropValueSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
        }
    }
}

/** Le réglage est resté tel que le catalogue le propose. */
export function isDefault(spec: OptionSpec, value: OptionValue | undefined): boolean {
    const initial = defaultOf(spec);
    if (value === undefined || value === initial) return true;
    if (typeof value !== 'object' || typeof initial !== 'object' || value === null || initial === null) return false;
    const [a, b] = [value, initial] as [Record<string, unknown>, Record<string, unknown>];
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);
}

export function conditionsOf(spec: OptionSpec): readonly OptionCondition[] {
    if (!spec.when) return [];
    return 'option' in spec.when ? [spec.when] : spec.when;
}

export function isActive(spec: OptionSpec, values: OptionValues): boolean {
    return conditionsOf(spec).every((condition) => values[condition.option] === condition.equals);
}

/**
 * Les valeurs complètes d'une conversion : celles reçues quand elles
 * conviennent, les défauts sinon, et rien qui ne soit déclaré. Un réglage
 * masqué par son `when` retombe sur son défaut.
 */
export function resolveOptions(specs: readonly OptionSpec[], values: OptionValues): OptionValues {
    const resolved: OptionValues = {};
    for (const spec of specs) resolved[spec.id] = coerce(spec, values[spec.id]);
    for (const spec of specs) if (!isActive(spec, resolved)) resolved[spec.id] = defaultOf(spec);
    return resolved;
}

export const num = (values: OptionValues, id: string): number | null =>
    typeof values[id] === 'number' ? (values[id] as number) : null;
export const str = (values: OptionValues, id: string): string | null =>
    typeof values[id] === 'string' ? (values[id] as string) : null;
export const flag = (values: OptionValues, id: string): boolean => values[id] === true;
export const sizeOf = (values: OptionValues, id: string): SizeValue => {
    const parsed = sizeValueSchema.safeParse(values[id]);
    return parsed.success ? parsed.data : EMPTY_SIZE;
};
export const cropOf = (values: OptionValues, id: string): CropValue | null => {
    const parsed = cropValueSchema.safeParse(values[id]);
    return parsed.success ? parsed.data : null;
};
