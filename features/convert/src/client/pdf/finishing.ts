import type { Rect } from './geometry';
import type { Size } from './model';

/**
 * Les finitions du document produit : numéros de page, filigrane,
 * propriétés, mot de passe. Des réglages purs, que l'assemblage applique à
 * chaque page après ce qui y est posé.
 */

export type NumberEdge = 'top' | 'bottom';
export type NumberAlign = 'left' | 'center' | 'right';
export type NumberPosition = `${NumberEdge}-${NumberAlign}`;
export type NumberFormat = 'n' | 'n-total' | 'page-n-total';

export interface Finishing {
    numbers: {
        on: boolean;
        position: NumberPosition;
        format: NumberFormat;
        /** Le numéro de la première page numérotée. */
        start: number;
        /** La page de garde ne porte pas de numéro. */
        skipFirst: boolean;
    };
    watermark: {
        on: boolean;
        text: string;
        size: number;
        /** De 0 à 1. */
        opacity: number;
        diagonal: boolean;
    };
    metadata: {
        title: string;
        author: string;
        subject: string;
        /** Aucune information dans le document produit, pas même celles des fichiers d'origine. */
        strip: boolean;
    };
    /** Le mot de passe d'ouverture, `null` pour un document libre. */
    password: string | null;
}

export const DEFAULT_FINISHING: Finishing = {
    numbers: { on: false, position: 'bottom-center', format: 'n', start: 1, skipFirst: false },
    watermark: { on: false, text: 'CONFIDENTIEL', size: 72, opacity: 0.2, diagonal: true },
    metadata: { title: '', author: '', subject: '', strip: false },
    password: null
};

export const NUMBER_SIZE = 10;
export const NUMBER_MARGIN = 24;
export const WATERMARK_ANGLE = 45;
export const WATERMARK_MIN_SIZE = 24;
export const WATERMARK_MAX_SIZE = 160;

export const NUMBER_EDGES: readonly { value: NumberEdge; label: string }[] = [
    { value: 'bottom', label: 'En bas' },
    { value: 'top', label: 'En haut' }
];

export const NUMBER_ALIGNS: readonly { value: NumberAlign; label: string }[] = [
    { value: 'left', label: 'À gauche' },
    { value: 'center', label: 'Au centre' },
    { value: 'right', label: 'À droite' }
];

export const splitPosition = (position: NumberPosition): { edge: NumberEdge; align: NumberAlign } => {
    const [edge, align] = position.split('-') as [NumberEdge, NumberAlign];
    return { edge, align };
};

export const NUMBER_FORMATS: readonly { value: NumberFormat; label: string }[] = [
    { value: 'n', label: '3' },
    { value: 'n-total', label: '3 / 12' },
    { value: 'page-n-total', label: 'Page 3 sur 12' }
];

/** Ce que porte la page `index` (base 0) d'un document de `total` pages ; `null` quand elle n'est pas numérotée. */
export function pageNumberLabel(numbers: Finishing['numbers'], index: number, total: number): string | null {
    if (!numbers.on) return null;
    if (numbers.skipFirst && index === 0) return null;
    const first = numbers.skipFirst ? 1 : 0;
    const n = numbers.start + index - first;
    const count = numbers.start + total - 1 - first;
    switch (numbers.format) {
        case 'n':
            return `${n}`;
        case 'n-total':
            return `${n} / ${count}`;
        case 'page-n-total':
            return `Page ${n} sur ${count}`;
    }
}

/** La boîte du numéro dans le cadre affiché, pour un texte de `width` points. */
export function numberBox(position: NumberPosition, page: Size, width: number, size = NUMBER_SIZE): Rect {
    const { edge, align } = splitPosition(position);
    const y = edge === 'top' ? NUMBER_MARGIN : page.height - NUMBER_MARGIN - size;
    const x =
        align === 'center'
            ? (page.width - width) / 2
            : align === 'right'
              ? page.width - NUMBER_MARGIN - width
              : NUMBER_MARGIN;
    return { x, y, width, height: size };
}
