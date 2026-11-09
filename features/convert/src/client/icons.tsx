import type { ReactElement } from 'react';

/**
 * Les pictogrammes des cartes. Dessinés ici et non dans l'app : ils ne servent
 * qu'à ce module. Au trait, en `currentColor` : la carte décide de la teinte.
 */

export type PictoId =
    | 'video'
    | 'audio'
    | 'image'
    | 'document'
    | 'currency'
    | 'units'
    | 'pdf'
    | 'merge'
    | 'extract'
    | 'reorder'
    | 'undo'
    | 'redo'
    | 'rotateLeft'
    | 'rotateRight'
    | 'duplicate'
    | 'blank'
    | 'select'
    | 'signature'
    | 'initials'
    | 'text'
    | 'date'
    | 'check'
    | 'cross'
    | 'highlight'
    | 'box'
    | 'ink'
    | 'redact'
    | 'prev'
    | 'next'
    | 'lock';

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
    ),
    pdf: (
        <>
            <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
            <path d='M14 2v6h6' />
            <path d='M8 17v-5h1.6a1.5 1.5 0 0 1 0 3H8M12.5 12v5h1a2.5 2.5 0 0 0 0-5zM17 17v-5h2.5M17 14.5h2' />
        </>
    ),
    merge: (
        <>
            <rect x='3' y='3' width='8' height='10' rx='1.5' />
            <rect x='13' y='3' width='8' height='10' rx='1.5' />
            <path d='M7 13v3a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3M12 18v3M9.5 20.5L12 23l2.5-2.5' />
        </>
    ),
    extract: (
        <>
            <rect x='3' y='3' width='11' height='14' rx='1.5' />
            <path d='M6 7h5M6 10h5M6 13h3' />
            <path d='M14 10h7M18 7l3 3-3 3' />
            <rect x='15' y='15' width='6' height='6' rx='1' />
        </>
    ),
    reorder: (
        <>
            <rect x='3' y='3' width='7' height='9' rx='1.5' />
            <rect x='14' y='12' width='7' height='9' rx='1.5' />
            <path d='M14 6h4a2 2 0 0 1 2 2v1M10 18H6a2 2 0 0 1-2-2v-1' />
            <path d='M18 6.5l2 2.5 2-2.5M6 17.5L4 15l-2 2.5' />
        </>
    ),
    undo: (
        <>
            <path d='M9 14L4 9l5-5' />
            <path d='M4 9h10a6 6 0 0 1 0 12h-3' />
        </>
    ),
    redo: (
        <>
            <path d='M15 14l5-5-5-5' />
            <path d='M20 9H10a6 6 0 0 0 0 12h3' />
        </>
    ),
    rotateLeft: (
        <>
            <path d='M3 12a9 9 0 1 0 3-6.7' />
            <path d='M3 4v5h5' />
        </>
    ),
    rotateRight: (
        <>
            <path d='M21 12a9 9 0 1 1-3-6.7' />
            <path d='M21 4v5h-5' />
        </>
    ),
    duplicate: (
        <>
            <rect x='8' y='8' width='13' height='13' rx='2' />
            <path d='M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3' />
        </>
    ),
    blank: (
        <>
            <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
            <path d='M14 2v6h6M12 11v6M9 14h6' />
        </>
    ),
    select: <path d='M5 3l14 8-6.5 1.5L10 19z' />,
    signature: (
        <>
            <path d='M3 18c3-6 5-9 7-9s1 6 3 6 3-4 5-4 2 2 3 2' />
            <path d='M3 21h18' />
        </>
    ),
    initials: (
        <>
            <path d='M4 20l4-13 4 13M6 15h4' />
            <path d='M14 7h3.5a2.5 2.5 0 0 1 0 5H14zM14 12h4a3 3 0 0 1 0 6h-4z' />
        </>
    ),
    text: (
        <>
            <path d='M4 6V4h16v2M12 4v16M9 20h6' />
        </>
    ),
    date: (
        <>
            <rect x='3' y='5' width='18' height='16' rx='2' />
            <path d='M3 10h18M8 3v4M16 3v4' />
        </>
    ),
    check: <path d='M4 12.5l5.5 5.5L20 6' />,
    cross: <path d='M5 5l14 14M19 5L5 19' />,
    highlight: (
        <>
            <path d='M4 20h6M9 15l6-10 4 2.5-6 10z' />
            <path d='M9 15l-1 4 4-1.5' />
        </>
    ),
    box: <rect x='4' y='5' width='16' height='14' rx='2' />,
    ink: (
        <>
            <path d='M16 3l5 5-11 11H5v-5z' />
            <path d='M13 6l5 5' />
        </>
    ),
    redact: (
        <>
            <rect x='3' y='8' width='18' height='8' rx='1.5' />
            <path d='M3 4h8M3 20h12' />
        </>
    ),
    lock: (
        <>
            <rect x='4' y='10' width='16' height='11' rx='2' />
            <path d='M8 10V7a4 4 0 0 1 8 0v3' />
        </>
    ),
    prev: <path d='M15 5l-7 7 7 7' />,
    next: <path d='M9 5l7 7-7 7' />
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
