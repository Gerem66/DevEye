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
}

/**
 * La taille du résultat, avant de l'avoir produit. Le calcul du catalogue
 * répond tout de suite ; pour une image que le navigateur sait encoder, un
 * essai réel le remplace dès qu'il est prêt, et sert aussi d'aperçu.
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
    const [measured, setMeasured] = useState<{ key: string; blob: Blob } | null>(null);

    const recipe = target?.recipe;
    const type = recipe?.engine === 'image' ? CANVAS_TYPES[recipe.coder] : undefined;
    const key =
        type && info ? JSON.stringify([target?.id, values.quality, values.resize, values.crop, info.bytes]) : null;

    useEffect(() => {
        if (!key || !type || !file || !info?.width || !info.height) return;
        const source = { width: info.width, height: info.height };
        const crop = cropRect(source, cropOf(values, 'crop'));
        const dims = imageDims(source, cropOf(values, 'crop'), sizeOf(values, 'resize'));
        if (dims.width * dims.height > CANVAS_MAX_PIXELS) return;

        let cancelled = false;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const bitmap = await createImageBitmap(file);
                    const canvas = document.createElement('canvas');
                    canvas.width = dims.width;
                    canvas.height = dims.height;
                    const area = crop ?? { x: 0, y: 0, ...source };
                    canvas
                        .getContext('2d')
                        ?.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, dims.width, dims.height);
                    bitmap.close();
                    canvas.toBlob(
                        (blob) => {
                            if (blob && !cancelled) setMeasured({ key, blob });
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
        // `values` est résumé par `key` : seuls les réglages qui pèsent relancent l'essai.
    }, [key, type, file, info]);

    const fresh = measured && measured.key === key ? measured.blob : null;
    return { estimate: fresh ? { bytes: fresh.size, exact: false } : computed, sample: fresh };
}
