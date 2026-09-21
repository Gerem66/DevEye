import type { CSSProperties } from 'react';

import type { Dims, Rect } from '../contracts/geometry';

/**
 * Le cadrage du résultat appliqué au média d'origine, en CSS pur : il est
 * agrandi et décalé derrière une fenêtre aux proportions du recadrage. Vaut pour
 * une image comme pour une vidéo, sans rien encoder.
 */
export function framing(source: Dims, area: Rect | null): CSSProperties {
    if (!area) return { width: '100%', height: '100%', left: 0, top: 0 };
    return {
        width: `${(source.width / area.width) * 100}%`,
        height: `${(source.height / area.height) * 100}%`,
        left: `${(-area.x / area.width) * 100}%`,
        top: `${(-area.y / area.height) * 100}%`
    };
}
