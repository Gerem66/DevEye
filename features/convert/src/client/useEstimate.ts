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
    /** L'image telle qu'elle sortirait, quand le navigateur a su l'encoder : de quoi comparer avant et après. */
    sample: Blob | null;
    /** Un essai d'encodage est en route : `estimate`, s'il y en a une, est provisoire. */
    pending: boolean;
}

/** Le dernier essai abouti, et ce que le calcul du catalogue disait au même moment. */
interface Measure {
    /** Le fichier et la cible : hors d'eux, un essai ne dit plus rien. */
    scope: string;
    /** Les réglages qui pèsent. */
    key: string;
    blob: Blob;
    computedBytes: number | null;
}

/**
 * Le calcul du catalogue, recalé sur un essai réel de la même image dans le même
 * format : le rapport entre ce qu'il disait alors et ce que l'essai a pesé.
 */
export function recalibrate(
    computedBytes: number | null,
    measuredBytes: number,
    computedThen: number | null
): number | null {
    if (!computedBytes || !computedThen) return null;
    return Math.round(computedBytes * (measuredBytes / computedThen));
}

/**
 * La taille du résultat, avant de l'avoir produit.
 *
 * Pour une image que le navigateur sait encoder, un essai réel fait foi. Entre
 * deux essais, le calcul du catalogue ne s'affiche jamais tel quel : il ignore
 * ce que l'image contient et peut se tromper du simple au quadruple, ce qui
 * ferait sauter le chiffre à chaque geste. Il est recalé sur le dernier essai
 * (même image, même format : l'erreur est la même), si bien que le chiffre suit
 * le curseur sans à-coup, puis se corrige de peu. Le dernier aperçu reste en
 * place de la même façon.
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
    const key = scope ? JSON.stringify([values.quality, values.resize, values.crop]) : null;
    const computedBytes = computed?.bytes ?? null;

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
                            if (blob && !cancelled) setMeasure({ scope, key, blob, computedBytes });
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
    if (last?.key === key)
        return { estimate: { bytes: last.blob.size, exact: false }, sample: last.blob, pending: false };

    const bytes = last ? recalibrate(computedBytes, last.blob.size, last.computedBytes) : null;
    const recalibrated = bytes === null ? null : { bytes, exact: false };
    return { estimate: recalibrated, sample: last?.blob ?? null, pending: true };
}
