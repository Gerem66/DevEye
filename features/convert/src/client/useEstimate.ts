import { useEffect, useMemo, useState } from 'react';

import type { TargetFormat } from '../contracts/catalogue';
import { estimateSize, type MediaInfo, type SizeEstimate } from '../contracts/estimate';
import { cropRect, imageDims } from '../contracts/geometry';
import { cropOf, num, sizeOf, type OptionValues } from '../contracts/options';

/** Les formats que le navigateur sait encoder lui-même, et donc peser pour de vrai. */
const CANVAS_TYPES: Record<string, string> = { JPEG: 'image/jpeg', WEBP: 'image/webp', PNG: 'image/png' };
/** Au-delà, l'essai coûterait plus de mémoire qu'il ne rapporte de précision. */
const CANVAS_MAX_PIXELS = 24_000_000;
const DEBOUNCE_MS = 350;

export interface Estimation {
    estimate: SizeEstimate | null;
    /**
     * L'image telle qu'elle sortirait, quand le navigateur a su l'encoder : de
     * quoi comparer avant et après. Seulement si elle a le cadrage en cours : un
     * essai d'avant le dernier recadrage, étiré dans le nouveau cadre, montrerait
     * une image déformée à côté de la bonne.
     */
    sample: Blob | null;
    /** Un essai d'encodage est en route : `estimate`, s'il y en a une, est celle d'avant le dernier geste. */
    pending: boolean;
}

/** Le dernier essai abouti. */
interface Measure {
    /** Le fichier et la cible : hors d'eux, un essai ne dit plus rien. */
    scope: string;
    /** Les réglages qui pèsent. */
    key: string;
    /** Parmi eux, ceux qui changent la forme de l'image. */
    geometry: string;
    blob: Blob;
}

/**
 * La taille du résultat, avant de l'avoir produit.
 *
 * Pour une image que le navigateur sait encoder, un essai réel fait foi, et lui
 * seul : le calcul du catalogue ignore ce que l'image contient et peut se
 * tromper du simple au quadruple. Entre deux essais, c'est donc la dernière
 * valeur mesurée qui reste, signalée comme dépassée (`pending`), jamais un
 * chiffre intermédiaire qu'on pourrait lire pour vrai. Le dernier aperçu reste
 * en place de la même façon, tant que le cadrage n'a pas bougé.
 */
export function useEstimate(
    target: TargetFormat | null,
    values: OptionValues,
    info: MediaInfo | null,
    file: File | null
): Estimation {
    const computed = useMemo(
        () => (target && info ? estimateSize(target, values, info) : null),
        [target, values, info]
    );
    const [measure, setMeasure] = useState<Measure | null>(null);

    const recipe = target?.recipe;
    const type = recipe?.engine === 'image' ? CANVAS_TYPES[recipe.coder] : undefined;
    const source = info?.width && info.height ? { width: info.width, height: info.height } : null;
    const dims = source ? imageDims(source, cropOf(values, 'crop'), sizeOf(values, 'resize')) : null;
    const measurable = Boolean(type && file && dims && dims.width * dims.height <= CANVAS_MAX_PIXELS);

    const scope = measurable && file && target ? `${target.id}|${file.name}|${file.size}|${file.lastModified}` : null;
    const geometry = JSON.stringify([values.resize, values.crop]);
    const key = scope ? JSON.stringify([values.quality, geometry]) : null;

    useEffect(() => {
        if (!scope || !key || !type || !file || !source || !dims) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const bitmap = await createImageBitmap(file);
                    const canvas = document.createElement('canvas');
                    canvas.width = dims.width;
                    canvas.height = dims.height;
                    const area = cropRect(source, cropOf(values, 'crop')) ?? { x: 0, y: 0, ...source };
                    canvas
                        .getContext('2d')
                        ?.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, dims.width, dims.height);
                    bitmap.close();
                    canvas.toBlob(
                        (blob) => {
                            if (blob && !cancelled) setMeasure({ scope, key, geometry, blob });
                        },
                        type,
                        (num(values, 'quality') ?? 82) / 100
                    );
                } catch {
                    // Un format que le navigateur n'ouvre pas garde le calcul du catalogue.
                }
            })();
        }, DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
        // `values`, `dims` et `source` sont résumés par `key` et `scope` : seuls les réglages qui pèsent relancent l'essai.
    }, [scope, key, type, file]);

    if (!scope) return { estimate: computed, sample: null, pending: false };

    const last = measure?.scope === scope ? measure : null;
    return {
        estimate: last ? { bytes: last.blob.size, exact: false } : null,
        sample: last?.geometry === geometry ? last.blob : null,
        pending: last?.key !== key
    };
}
