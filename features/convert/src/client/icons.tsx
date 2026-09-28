import type { ReactElement } from 'react';

/**
 * Les pictogrammes des cartes. Dessinés ici et non dans l'app : ils ne servent
 * qu'à ce module. Au trait, en `currentColor` : la carte décide de la teinte.
 */

export type PictoId = 'video' | 'audio' | 'image' | 'document' | 'currency' | 'units';

const PATHS: Record<PictoId, ReactElement> = {
    video: (
        <>
            <rect x='2' y='4' width='20' height='16' rx='2.5' />
            <path d='M10 9v6l5-3z' />
        </>
    ),
    audio: (
        <>
            <path d='M9 18V5l12-2v13' />
            <circle cx='6' cy='18' r='3' />
            <circle cx='18' cy='16' r='3' />
        </>
    ),
    image: (
        <>
            <rect x='3' y='3' width='18' height='18' rx='2.5' />
            <circle cx='8.5' cy='8.5' r='1.5' />
            <path d='M21 15l-5-5L5 21' />
        </>
    ),
    document: (
        <>
            <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
            <path d='M14 2v6h6M8 13h8M8 17h5' />
        </>
    ),
    currency: (
        <>
            <circle cx='8' cy='8' r='6' />
            <path d='M18.09 10.37A6 6 0 1 1 10.34 18' />
            <path d='M7 6h1v4' />
        </>
    ),
    units: (
        <>
            <path d='M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0z' />
            <path d='M14.5 12.5l2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2' />
        </>
    )
};

export function Picto({ id, size = 28 }: { id: PictoId; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.8'
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden='true'
        >
            {PATHS[id]}
        </svg>
    );
}
