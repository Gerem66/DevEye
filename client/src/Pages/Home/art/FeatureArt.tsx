import type { ReactNode } from 'react';
import type { HomeFeatureId } from '@deveye/types';

import styles from './FeatureArt.module.css';

/**
 * Les vignettes des fonctionnalités : un dessin par feature (cadre 160 × 90),
 * en tête de sa carte au marché et de sa fiche « À propos ». Même trait, même
 * palette : l'accent pour ce qui porte le sens, `--text-muted` pour la
 * structure, les couleurs d'état seulement là où l'état est le sujet. Chaque
 * dessin montre la forme de l'écran, pas son icône agrandie. Couleurs en
 * variables CSS, jamais en dur : l'accent d'un espace est réglable.
 */

const A = 'var(--accent)';
const M = 'var(--text-muted)';
const OK = 'var(--success)';
const KO = 'var(--danger)';
const WARN = 'var(--warning)';

/** Le trait courant : ce qui donne leur air de famille à tous les dessins. */
const stroke = { fill: 'none', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const thin = { fill: 'none', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** Une ligne de texte figurée : le motif de base des écrans de listes. */
function Line({
    x,
    y,
    w,
    c = M,
    o = 0.55,
    h = 5
}: {
    x: number;
    y: number;
    w: number;
    c?: string;
    o?: number;
    h?: number;
}) {
    return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={c} opacity={o} />;
}

/** Une carte figurée : le motif de base des écrans de cartes. */
function Card({ x, y, w, h, c = M, o = 0.22 }: { x: number; y: number; w: number; h: number; c?: string; o?: number }) {
    return <rect x={x} y={y} width={w} height={h} rx='4' fill={c} opacity={o} />;
}

/**
 * Une fonctionnalité, ou l'un des deux autres genres de carte du marché : une
 * carte d'appareil sans vignette au milieu des autres se lirait comme cassée.
 */
export type ArtId = HomeFeatureId | 'device' | 'shortcut';

/**
 * La zone utile, commune à tous les dessins : x 16 → 144, contenu centré sur
 * y 45. Toute nouvelle vignette se cadre là-dedans, bords compris, sinon les
 * marges ne tombent pas au même endroit d'une carte à l'autre.
 */
const ART: Record<ArtId, ReactNode> = {
    // Une courbe d'activité, et les trois jauges qui l'accompagnent partout.
    devices: (
        <>
            <path d='M16 54 36 42 54 48 72 28 90 36 110 18 128 26 144 16 144 62 16 62Z' fill={A} opacity='0.16' />
            <path d='M16 54 36 42 54 48 72 28 90 36 110 18 128 26 144 16' stroke={A} {...stroke} />
            <line x1='16' y1='62' x2='144' y2='62' stroke={M} {...thin} />
            <Line x={16} y={70} w={38} o={0.2} h={6} />
            <Line x={16} y={70} w={28} c={A} o={0.85} h={6} />
            <Line x={61} y={70} w={38} o={0.2} h={6} />
            <Line x={61} y={70} w={19} c={A} o={0.6} h={6} />
            <Line x={106} y={70} w={38} o={0.2} h={6} />
            <Line x={106} y={70} w={11} c={A} o={0.45} h={6} />
        </>
    ),
    // Le soleil derrière un nuage, et la courbe des heures qui suivent.
    weather: (
        <>
            <circle cx='48' cy='30' r='12' stroke={WARN} {...stroke} />
            <line x1='48' y1='11' x2='48' y2='15' stroke={WARN} {...stroke} />
            <line x1='29' y1='30' x2='33' y2='30' stroke={WARN} {...stroke} />
            <line x1='34' y1='16' x2='37' y2='19' stroke={WARN} {...stroke} />
            <line x1='34' y1='44' x2='37' y2='41' stroke={WARN} {...stroke} />
            <g transform='translate(-3 8)'>
                <path
                    d='M62 40h40a12 12 0 0 0 0-24 16 16 0 0 0-30-4 11 11 0 0 0-10 28Z'
                    fill={A}
                    opacity='0.18'
                    stroke={A}
                    strokeWidth='2.4'
                    strokeLinejoin='round'
                />
            </g>
            <path d='M16 72 42 64 68 68 94 58 120 62 144 52' stroke={A} {...thin} />
            <circle cx='42' cy='64' r='2.6' fill={A} />
            <circle cx='94' cy='58' r='2.6' fill={A} />
            <circle cx='144' cy='52' r='2.6' fill={A} />
        </>
    ),
    // Des identifiants masqués, rangés, dont un est déverrouillé.
    password: (
        <>
            <Card x={16} y={14} w={128} h={18} />
            <circle cx='28' cy='23' r='5' stroke={M} {...thin} />
            <Line x={42} y={18} w={40} o={0.7} />
            <Line x={42} y={26} w={62} o={0.35} h={4} />

            <Card x={16} y={36} w={128} h={18} c={A} o={0.18} />
            <path d='M24 43v-3a4 4 0 0 1 8 0' stroke={A} {...stroke} />
            <rect x='22' y='43' width='12' height='9' rx='2' fill={A} opacity='0.9' />
            <Line x={42} y={39} w={44} c={A} o={0.8} />
            <circle cx='44' cy='49' r='2' fill={M} opacity='0.7' />
            <circle cx='51' cy='49' r='2' fill={M} opacity='0.7' />
            <circle cx='58' cy='49' r='2' fill={M} opacity='0.7' />
            <circle cx='65' cy='49' r='2' fill={M} opacity='0.7' />
            <circle cx='72' cy='49' r='2' fill={M} opacity='0.7' />

            <Card x={16} y={58} w={128} h={18} />
            <circle cx='28' cy='67' r='5' stroke={M} {...thin} />
            <Line x={42} y={62} w={32} o={0.7} />
            <Line x={42} y={70} w={54} o={0.35} h={4} />
        </>
    ),
    // Une note écrite, son coin replié, et un passage surligné.
    notes: (
        <>
            <path d='M32 12h72l24 24v38a4 4 0 0 1-4 4H32a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z' fill={M} opacity='0.14' />
            <path d='M32 12h72l24 24v38a4 4 0 0 1-4 4H32a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z' stroke={M} {...thin} />
            <path d='M104 12v24h24' stroke={M} {...thin} />
            <Line x={40} y={44} w={72} o={0.5} />
            <rect x='40' y='54' width='54' height='7' rx='3.5' fill={A} opacity='0.4' />
            <Line x={40} y={66} w={62} o={0.5} />
        </>
    ),
    // La frise de sondes, le dessin qui appartient à Uptime et à personne d'autre.
    uptime: (
        <>
            <Line x={16} y={14} w={44} c={A} o={0.85} h={6} />
            <Line x={120} y={14} w={24} o={0.3} h={6} />
            <rect x='16' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='27' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='38' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='49' y='34' width='6' height='30' rx='3' fill={WARN} opacity='0.9' />
            <rect x='60' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='71' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='82' y='34' width='6' height='30' rx='3' fill={KO} opacity='0.9' />
            <rect x='93' y='34' width='6' height='30' rx='3' fill={KO} opacity='0.9' />
            <rect x='104' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='115' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='126' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <rect x='137' y='34' width='6' height='30' rx='3' fill={OK} opacity='0.85' />
            <Line x={16} y={70} w={26} o={0.3} h={4} />
            <Line x={118} y={70} w={26} o={0.3} h={4} />
        </>
    ),
    // Un bouclier, et le balayage qui vient de trouver quelque chose.
    sentinel: (
        <>
            <path d='M80 11 116 23v22c0 20-15 30-36 34-21-4-36-14-36-34V23Z' fill={A} opacity='0.14' />
            <path d='M80 11 116 23v22c0 20-15 30-36 34-21-4-36-14-36-34V23Z' stroke={A} {...stroke} />
            <path d='M62 45a18 18 0 0 1 36 0' stroke={M} {...thin} />
            <path d='M70 53a10 10 0 0 1 20 0' stroke={M} {...thin} />
            <circle cx='80' cy='45' r='2.6' fill={A} />
            <circle cx='95' cy='33' r='3.4' fill={KO} />
        </>
    ),
    // Deux appareils, un nuage, et le va-et-vient entre les trois.
    cloudsync: (
        <>
            <g transform='translate(-3 2)'>
                <path
                    d='M62 40h40a12 12 0 0 0 0-24 16 16 0 0 0-30-4 11 11 0 0 0-10 28Z'
                    fill={A}
                    opacity='0.18'
                    stroke={A}
                    strokeWidth='2.4'
                    strokeLinejoin='round'
                />
            </g>
            <rect x='16' y='52' width='42' height='24' rx='4' fill={M} opacity='0.18' />
            <rect x='16' y='52' width='42' height='24' rx='4' stroke={M} {...thin} />
            <rect x='102' y='52' width='42' height='24' rx='4' fill={M} opacity='0.18' />
            <rect x='102' y='52' width='42' height='24' rx='4' stroke={M} {...thin} />
            <path d='M46 48 62 38' stroke={A} {...stroke} />
            <path d='M56 38h6v6' stroke={A} {...stroke} />
            <path d='M114 48 98 38' stroke={A} {...stroke} />
            <path d='M104 38h-6v6' stroke={A} {...stroke} />
        </>
    ),
    // Un tableau : trois colonnes, des cartes, et celle qu'on est en train de bouger.
    projects: (
        <>
            <Card x={16} y={16} w={40} h={58} o={0.1} />
            <Card x={60} y={16} w={40} h={58} o={0.1} />
            <Card x={104} y={16} w={40} h={58} o={0.1} />
            <Line x={20} y={22} w={22} o={0.45} h={4} />
            <Line x={64} y={22} w={26} o={0.45} h={4} />
            <Line x={108} y={22} w={18} o={0.45} h={4} />
            <Card x={20} y={32} w={32} h={14} />
            <Card x={20} y={50} w={32} h={14} />
            <Card x={64} y={32} w={32} h={14} c={A} o={0.42} />
            <Card x={64} y={50} w={32} h={14} />
            <Card x={108} y={32} w={32} h={14} />
            <Card x={108} y={50} w={32} h={14} o={0.14} />
        </>
    ),
    // Le graphe des commits : deux voies, une bifurcation, une fusion. Deux
    // hauteurs franches et des raccords en S courts, sinon on lit une colline.
    git: (
        <>
            <line x1='16' y1='56' x2='144' y2='56' stroke={M} strokeWidth='2.4' strokeLinecap='round' />
            <path d='M50 56C58 56 58 22 66 22' stroke={A} {...stroke} />
            <line x1='66' y1='22' x2='114' y2='22' stroke={A} strokeWidth='2.4' strokeLinecap='round' />
            <path d='M114 22C122 22 122 56 130 56' stroke={A} {...stroke} />
            <circle cx='16' cy='56' r='4.5' fill={M} opacity='0.55' />
            <circle cx='50' cy='56' r='5.5' fill={A} />
            <circle cx='90' cy='56' r='4.5' fill={M} opacity='0.55' />
            <circle cx='130' cy='56' r='5.5' fill={A} />
            <circle cx='78' cy='22' r='5.5' fill={A} />
            <circle cx='102' cy='22' r='5.5' fill={A} />
            <Line x={16} y={70} w={54} o={0.28} h={4} />
            <Line x={98} y={70} w={46} o={0.28} h={4} />
        </>
    ),
    // Le trajet d'une mise en production, et sa barre d'avancement.
    deploy: (
        <>
            <rect x='16' y='24' width='34' height='26' rx='4' fill={M} opacity='0.18' />
            <rect x='16' y='24' width='34' height='26' rx='4' stroke={M} {...thin} />
            <path d='M56 37h32' stroke={A} {...stroke} />
            <path d='M82 31l6 6-6 6' stroke={A} {...stroke} />
            <rect x='96' y='18' width='48' height='38' rx='5' fill={A} opacity='0.16' />
            <rect x='96' y='18' width='48' height='38' rx='5' stroke={A} {...stroke} />
            <Line x={104} y={26} w={32} c={A} o={0.7} h={4} />
            <Line x={104} y={36} w={20} o={0.45} h={4} />
            <Line x={16} y={66} w={128} o={0.18} h={7} />
            <Line x={16} y={66} w={90} c={A} o={0.85} h={7} />
        </>
    ),
    // Le cylindre, et la table qu'on est en train de parcourir.
    database: (
        <>
            <ellipse cx='43' cy='27' rx='27' ry='9' fill={A} opacity='0.22' />
            <ellipse cx='43' cy='27' rx='27' ry='9' stroke={A} {...thin} />
            <path d='M16 27v36c0 5 12 9 27 9s27-4 27-9V27' stroke={A} {...stroke} />
            <path d='M16 45c0 5 12 9 27 9s27-4 27-9' stroke={A} {...thin} />
            <rect x='82' y='18' width='62' height='54' rx='4' fill={M} opacity='0.12' />
            <rect x='82' y='18' width='62' height='54' rx='4' stroke={M} {...thin} />
            <line x1='82' y1='32' x2='144' y2='32' stroke={M} {...thin} />
            <line x1='82' y1='45' x2='144' y2='45' stroke={M} {...thin} />
            <line x1='82' y1='59' x2='144' y2='59' stroke={M} {...thin} />
            <line x1='113' y1='18' x2='113' y2='72' stroke={M} {...thin} />
        </>
    ),
    // Trois copies empilées qui partent vers un disque : ce que la feature fait,
    // dans l'ordre où elle le fait.
    backup: (
        <>
            <rect x='16' y='20' width='52' height='14' rx='3' fill={A} opacity='0.22' />
            <rect x='16' y='20' width='52' height='14' rx='3' stroke={A} {...thin} />
            <rect x='16' y='38' width='52' height='14' rx='3' fill={A} opacity='0.35' />
            <rect x='16' y='38' width='52' height='14' rx='3' stroke={A} {...thin} />
            <rect x='16' y='56' width='52' height='14' rx='3' fill={A} opacity='0.5' />
            <rect x='16' y='56' width='52' height='14' rx='3' stroke={A} {...stroke} />
            <path d='M76 45h22' stroke={A} {...stroke} />
            <path d='M92 39l7 6-7 6' stroke={A} {...stroke} />
            <rect x='108' y='22' width='36' height='46' rx='5' fill={M} opacity='0.12' />
            <rect x='108' y='22' width='36' height='46' rx='5' stroke={M} {...thin} />
            <circle cx='126' cy='45' r='11' stroke={M} {...thin} />
            <circle cx='126' cy='45' r='3' fill={M} opacity='0.6' />
        </>
    ),
    // Un solde qui monte, et le journal des opérations sous lui.
    finance: (
        <>
            <rect x='16' y='48' width='14' height='22' rx='3' fill={A} opacity='0.35' />
            <rect x='36' y='38' width='14' height='32' rx='3' fill={A} opacity='0.5' />
            <rect x='56' y='42' width='14' height='28' rx='3' fill={A} opacity='0.4' />
            <rect x='76' y='26' width='14' height='44' rx='3' fill={A} opacity='0.75' />
            <path d='M23 42 43 32 63 36 83 20' stroke={A} {...stroke} />
            <circle cx='83' cy='20' r='3.4' fill={A} />
            <Line x={104} y={22} w={40} o={0.45} />
            <Line x={104} y={36} w={28} c={OK} o={0.8} />
            <Line x={104} y={50} w={34} o={0.35} />
            <Line x={104} y={64} w={22} c={KO} o={0.7} />
        </>
    ),
    // L'entonnoir des visiteurs et la tendance à côté. Un entonnoir plutôt
    // qu'une courbe : Monitoring en porte déjà une.
    audience: (
        <>
            <rect x='16' y='18' width='78' height='14' rx='7' fill={A} opacity='0.75' />
            <rect x='16' y='38' width='56' height='14' rx='7' fill={A} opacity='0.5' />
            <rect x='16' y='58' width='32' height='14' rx='7' fill={A} opacity='0.32' />
            <line x1='106' y1='72' x2='106' y2='18' stroke={M} {...thin} />
            <line x1='106' y1='72' x2='144' y2='72' stroke={M} {...thin} />
            <path d='M110 62 120 50 128 54 142 26' stroke={A} {...stroke} />
            <circle cx='120' cy='50' r='2.8' fill={A} />
            <circle cx='142' cy='26' r='2.8' fill={A} />
        </>
    ),
    // Un réseau de traces, et la loupe qui vient d'en isoler une.
    osint: (
        <>
            <line x1='32' y1='22' x2='68' y2='40' stroke={M} {...thin} />
            <line x1='32' y1='60' x2='68' y2='40' stroke={M} {...thin} />
            <line x1='68' y1='40' x2='114' y2='20' stroke={M} {...thin} />
            <line x1='68' y1='40' x2='98' y2='52' stroke={M} {...thin} />
            <circle cx='32' cy='22' r='4.5' fill={M} opacity='0.6' />
            <circle cx='32' cy='60' r='4.5' fill={M} opacity='0.6' />
            <circle cx='114' cy='20' r='4.5' fill={M} opacity='0.6' />
            <circle cx='68' cy='40' r='6' fill={A} />
            <circle cx='106' cy='56' r='14' fill={A} opacity='0.12' />
            <circle cx='106' cy='56' r='14' stroke={A} {...stroke} />
            <path d='M116 66 128 76' stroke={A} {...stroke} />
        </>
    ),
    // Une enveloppe, et la pile de messages derrière elle.
    mail: (
        <>
            <Card x={28} y={12} w={104} h={10} o={0.14} />
            <Card x={22} y={22} w={116} h={10} o={0.2} />
            <rect x='16' y='32' width='128' height='44' rx='5' fill={A} opacity='0.16' />
            <rect x='16' y='32' width='128' height='44' rx='5' stroke={A} {...stroke} />
            <path d='M16 36 80 60 144 36' stroke={A} {...stroke} />
            <circle cx='138' cy='38' r='6' fill={KO} />
        </>
    ),

    // Le fil des vulnérabilités : le champ de recherche, puis les constats
    // rangés par gravité, dont un épinglé.
    cve: (
        <>
            <rect x='16' y='10' width='128' height='16' rx='8' fill={M} opacity='0.14' />
            <circle cx='27' cy='17' r='4' stroke={M} {...thin} />
            <path d='M30 20 33 23' stroke={M} {...thin} />
            <Line x={39} y={15} w={42} o={0.4} h={6} />

            <rect x='16' y='34' width='22' height='9' rx='4.5' fill={KO} />
            <Line x={44} y={35} w={70} c={A} o={0.8} h={7} />
            <path
                d='M132 31.5 133.7 36.15 138.66 36.34 134.76 39.4 136.11 44.16 132 41.4 127.89 44.16 129.24 39.4 125.34 36.34 130.3 36.15Z'
                fill={A}
            />

            <rect x='16' y='50' width='22' height='9' rx='4.5' fill={WARN} opacity='0.85' />
            <Line x={44} y={51} w={56} o={0.45} h={7} />

            <rect x='16' y='66' width='22' height='9' rx='4.5' fill={M} opacity='0.45' />
            <Line x={44} y={67} w={64} o={0.3} h={7} />
        </>
    ),

    // Une machine : son nom, son état, et l'activité qui la traverse.
    device: (
        <>
            <rect x='16' y='18' width='128' height='54' rx='6' fill={M} opacity='0.14' />
            <rect x='16' y='18' width='128' height='54' rx='6' stroke={M} {...thin} />
            <Line x={26} y={28} w={48} c={A} o={0.85} />
            <circle cx='134' cy='30.5' r='4' fill={OK} />
            <Line x={26} y={44} w={34} o={0.2} h={6} />
            <Line x={26} y={44} w={24} c={A} o={0.75} h={6} />
            <Line x={63} y={44} w={34} o={0.2} h={6} />
            <Line x={63} y={44} w={15} c={A} o={0.55} h={6} />
            <Line x={100} y={44} w={34} o={0.2} h={6} />
            <Line x={100} y={44} w={9} c={A} o={0.4} h={6} />
            <Line x={26} y={58} w={62} o={0.28} h={4} />
        </>
    ),
    // Un lien épinglé : son logo, son titre, et le badge du service.
    shortcut: (
        <>
            <rect x='16' y='20' width='128' height='50' rx='6' fill={A} opacity='0.14' />
            <rect x='16' y='20' width='128' height='50' rx='6' stroke={A} {...thin} />
            <circle cx='40' cy='38' r='11' fill={A} opacity='0.55' />
            <Line x={58} y={32} w={52} c={A} o={0.8} />
            <Line x={58} y={42} w={36} o={0.4} h={4} />
            <rect x='122' y='26' width='12' height='12' rx='3' fill={M} opacity='0.5' />
            <Line x={28} y={56} w={26} o={0.3} h={4} />
            <Line x={60} y={56} w={26} o={0.3} h={4} />
        </>
    )
};

export interface FeatureArtProps {
    id: ArtId;
    className?: string;
}

/** La vignette d'une fonctionnalité. Purement décorative, donc hors de l'arbre
 *  d'accessibilité : le titre et la description juste à côté disent déjà tout. */
export function FeatureArt({ id, className }: FeatureArtProps) {
    return (
        <span className={`${styles.art} ${className ?? ''}`} aria-hidden='true'>
            <svg viewBox='0 0 160 90' className={styles.svg} role='presentation' focusable='false'>
                {ART[id]}
            </svg>
        </span>
    );
}

export default FeatureArt;
