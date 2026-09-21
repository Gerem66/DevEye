import { z } from 'zod';

/**
 * Les réglages d'une conversion, dits une fois : l'étape « Options » rend un
 * contrôle par entrée, le serveur relit les mêmes entrées pour composer ses
 * arguments. Ni l'un ni l'autre ne connaît un format.
 */

export const sizeValueSchema = z.object({
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable()
});
export type SizeValue = z.infer<typeof sizeValueSchema>;

/** En pixels de la source, origine en haut à gauche. */
export const cropValueSchema = z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
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

interface OptionBase {
    id: string;
    label: string;
    /** Une phrase pour quelqu'un qui débute, sous le contrôle. */
    hint?: string;
    /** Le réglage n'apparaît, et ne compte, que si un autre a cette valeur. */
    when?: { option: string; equals: string | boolean };
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
      })
    | (OptionBase & {
          kind: 'segments';
          options: readonly { value: string; label: string }[];
          default: string;
      })
    | (OptionBase & { kind: 'toggle'; default: boolean })
    /** `null` : laissé tel quel. */
    | (OptionBase & { kind: 'number'; min: number; max: number; step: number; unit?: string })
    /** Largeur et hauteur maximales, proportions toujours gardées. `null` : inchangé. */
    | (OptionBase & { kind: 'size' })
    | (OptionBase & { kind: 'crop' })
    /** Une taille de fichier, en octets. */
    | (OptionBase & { kind: 'bytes'; default: number });

const EMPTY_SIZE: SizeValue = { width: null, height: null };

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

export function isActive(spec: OptionSpec, values: OptionValues): boolean {
    return !spec.when || values[spec.when.option] === spec.when.equals;
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
