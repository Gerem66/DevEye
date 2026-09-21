import { GIF_DEFAULT_WIDTH, type TargetFormat } from '../contracts/catalogue';
import type { OptionSpec } from '../contracts/options';

/** Ce qu'on a lu du fichier d'origine, et que ses réglages gagnent à connaître. */
export interface SourceFacts {
    /** La qualité d'enregistrement d'un JPEG. */
    sourceQuality: number | null;
    /** Le débit d'un fichier audio, en kb/s. */
    audioKbps: number | null;
    /** La cadence et les dimensions d'une vidéo. */
    fps: number | null;
    width: number | null;
    height: number | null;
}

type SegmentsSpec = Extract<OptionSpec, { kind: 'segments' }>;

/** « Original » dit ce qu'il vaut pour ce fichier, en petit sous son libellé. */
function sourceDetail(spec: SegmentsSpec, detail: string): SegmentsSpec {
    return { ...spec, options: spec.options.map((o) => (o.value === 'source' ? { ...o, detail } : o)) };
}

const FPS = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

/** Réencodé à sa propre qualité, un JPEG garde son poids : il faut descendre un peu pour l'alléger. */
const BELOW_SOURCE = 5;
const LOWEST_DEFAULT = 40;

type SliderSpec = Extract<OptionSpec, { kind: 'slider' }>;

/**
 * Un curseur de qualité réglé sur ce que le fichier vaut déjà : un trait marque
 * sa qualité d'origine sur la piste, et le défaut passe dessous quand il était
 * au-dessus. Réencoder plus fidèlement que l'original l'alourdit sans rien
 * rendre de ce que la première compression a perdu.
 */
function anchored(spec: SliderSpec, source: number, lowered: number, said: string): SliderSpec {
    const heavier = source < spec.default;
    // Hors de la piste (un WAV face à un curseur de MP3), il n'y a rien à marquer ni à dire.
    if (source > spec.max) return spec;
    return {
        ...spec,
        indicator: source,
        default: heavier ? Math.max(spec.min, lowered) : spec.default,
        hint: heavier
            ? `Ce fichier est déjà ${said} (le trait sur la piste) : au-dessus, il grossirait sans rien gagner.`
            : `Ce fichier est ${said} (le trait sur la piste).`
    };
}

/**
 * Les réglages d'une cible, ajustés à CE fichier.
 *
 * La qualité d'un JPEG ne vaut que vers un JPEG : d'un format d'image à l'autre,
 * les échelles ne se comparent pas. Le débit d'un son, lui, se compare d'un
 * format à l'autre : aucun n'ajoute ce qu'un débit plus bas a déjà retiré.
 */
export function adaptOptions(target: TargetFormat, facts: SourceFacts): readonly OptionSpec[] {
    const recipe = target.recipe;
    const { sourceQuality, audioKbps, fps, width, height } = facts;
    return map(target.options, (spec) => {
        if (spec.kind === 'segments' && spec.id === 'fps' && fps !== null) {
            return sourceDetail(spec, `${FPS.format(fps)} i/s`);
        }
        if (spec.kind === 'segments' && spec.id === 'height' && height !== null) {
            return sourceDetail(spec, `${height}p`);
        }
        if (spec.kind !== 'slider') return spec;
        if (spec.id === 'gifScale' && width !== null) {
            // Un pourcentage fixe donnerait un timbre-poste d'une petite vidéo et un monstre d'une 4K :
            // le défaut vise une largeur, au cran le plus proche.
            const wanted = Math.round(((GIF_DEFAULT_WIDTH / width) * 100) / spec.step) * spec.step;
            return { ...spec, default: Math.min(spec.max, Math.max(spec.min, wanted)) };
        }
        if (spec.id === 'quality' && sourceQuality !== null && recipe.engine === 'image' && recipe.coder === 'JPEG') {
            const lowered = Math.max(LOWEST_DEFAULT, sourceQuality - BELOW_SOURCE);
            return anchored(spec, sourceQuality, lowered, `compressé à environ ${sourceQuality}`);
        }
        if (spec.id === 'bitrate' && audioKbps !== null && recipe.engine === 'audio') {
            // Le cran du curseur juste sous le débit d'origine.
            const lowered = spec.min + Math.floor((audioKbps - spec.min) / spec.step) * spec.step;
            return anchored(spec, audioKbps, lowered, `à environ ${audioKbps} kb/s`);
        }
        return spec;
    });
}

/** Le tableau d'origine quand rien n'a changé : qui le lit peut se fier à son identité. */
function map(specs: readonly OptionSpec[], adapt: (spec: OptionSpec) => OptionSpec): readonly OptionSpec[] {
    const adapted = specs.map(adapt);
    return adapted.some((spec, index) => spec !== specs[index]) ? adapted : specs;
}
