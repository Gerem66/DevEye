import type { TargetFormat } from '../contracts/catalogue';
import type { OptionSpec } from '../contracts/options';

/** Réencodé à sa propre qualité, un JPEG garde son poids : il faut descendre un peu pour l'alléger. */
const BELOW_SOURCE = 5;
const LOWEST_DEFAULT = 40;

/**
 * Les réglages d'une cible, ajustés à CE fichier. Un JPEG déjà compressé plus
 * fort que le défaut grossirait à être réencodé : l'encodeur repart des pixels,
 * défauts de la première compression compris, et les range plus fidèlement,
 * sans rien rendre de ce qui a été perdu. Le curseur part donc juste sous la
 * qualité d'origine, et le dit.
 *
 * Seulement vers un JPEG : d'un format à l'autre, les échelles de qualité ne se
 * comparent pas.
 */
export function adaptOptions(target: TargetFormat, sourceQuality: number | null): readonly OptionSpec[] {
    const recipe = target.recipe;
    if (sourceQuality === null || recipe.engine !== 'image' || recipe.coder !== 'JPEG') return target.options;
    const lowered = (spec: OptionSpec): OptionSpec =>
        spec.kind === 'slider' && spec.id === 'quality' && sourceQuality < spec.default
            ? {
                  ...spec,
                  default: Math.max(LOWEST_DEFAULT, sourceQuality - BELOW_SOURCE),
                  hint: `Ce fichier est déjà compressé à environ ${sourceQuality} : au-dessus, il grossirait sans rien gagner.`
              }
            : spec;
    const adapted = target.options.map(lowered);
    return adapted.some((spec, index) => spec !== target.options[index]) ? adapted : target.options;
}
