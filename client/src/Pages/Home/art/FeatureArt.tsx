import type { ReactNode } from 'react';
import type { HomeFeatureId } from 'deveye-types';

import styles from './FeatureArt.module.css';

/**
 * Les vignettes des fonctionnalités : un dessin par feature, au format allongé,
 * posé en tête de sa carte au marché et de sa fiche dans « À propos ».
 *
 * ## Un vocabulaire commun, pas quinze illustrations
 *
 * Toutes partagent le même cadre (160 × 90), la même épaisseur de trait, les
 * mêmes bouts arrondis et la même palette : l'accent du thème pour ce qui porte
 * le sens, `--text-muted` pour la structure autour, et les couleurs d'état
 * seulement là où l'état **est** le sujet (une sonde tombée, une alerte). C'est
 * ce qui fait qu'elles se lisent comme une famille quand on les voit côte à côte
 * dans le marché, au lieu de quinze petits tableaux sans rapport.
 *
 * Chaque dessin montre la **forme** de l'écran, pas son icône agrandie : des
 * lignes masquées pour les mots de passe, la frise de barres d'Uptime, le
 * graphe de commits de Git. On doit pouvoir reconnaître la page avant d'avoir lu
 * son nom.
 *
 * Les couleurs sont des variables CSS, jamais des valeurs en dur : l'accent d'un
 * espace est réglable, et une vignette qui ne suivrait pas jurerait avec tout ce
 * qui l'entoure. Le fond, lui, appartient au cadre (voir le module CSS).
 */

const A = 'var(--accent)';
const M = 'var(--text-muted)';
const OK = 'var(--success)';
const KO = 'var(--danger)';
const WARN = 'var(--warning)';

/** Le trait courant : ce qui donne leur air de famille aux quinze dessins. */
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
 * Ce qu'une vignette peut représenter : une fonctionnalité, ou l'un des trois
 * autres genres de tuile.
 *
 * Les trois derniers existent parce que le marché mélange les genres sur une
 * même grille : une carte d'appareil sans vignette au milieu de cartes qui en
 * ont se lirait comme une carte cassée, pas comme une carte d'un autre genre.
 */
export type ArtId = HomeFeatureId | 'device' | 'shortcut' | 'folder';

const ART: Record<ArtId, ReactNode> = {
    // Une courbe d'activité, et les trois jauges qui l'accompagnent partout.
    monitoring: (
        <>
            <path d='M14 60 34 48 52 54 70 34 88 42 108 24 126 32 146 22 146 68 14 68Z' fill={A} opacity='0.16' />
            <path d='M14 60 34 48 52 54 70 34 88 42 108 24 126 32 146 22' stroke={A} {...stroke} />
            <line x1='14' y1='68' x2='146' y2='68' stroke={M} {...thin} />
            <Line x={14} y={76} w={40} o={0.2} h={6} />
            <Line x={14} y={76} w={30} c={A} o={0.85} h={6} />
            <Line x={60} y={76} w={40} o={0.2} h={6} />
            <Line x={60} y={76} w={20} c={A} o={0.6} h={6} />
            <Line x={106} y={76} w={40} o={0.2} h={6} />
            <Line x={106} y={76} w={12} c={A} o={0.45} h={6} />
        </>
    ),
    // Le soleil derrière un nuage, et la courbe des heures qui suivent.
    weather: (
        <>
            <circle cx='56' cy='30' r='13' stroke={WARN} {...stroke} />
            <line x1='56' y1='9' x2='56' y2='13' stroke={WARN} {...stroke} />
            <line x1='35' y1='30' x2='39' y2='30' stroke={WARN} {...stroke} />
            <line x1='41' y1='15' x2='44' y2='18' stroke={WARN} {...stroke} />
            <path
                d='M78 46h28a11 11 0 0 0 0-22 15 15 0 0 0-28-4 10 10 0 0 0 0 26Z'
                fill={A}
                opacity='0.18'
                stroke={A}
                strokeWidth='2.4'
                strokeLinejoin='round'
            />
            <path d='M16 74 40 66 64 70 88 60 112 64 144 54' stroke={A} {...thin} />
            <circle cx='40' cy='66' r='2.6' fill={A} />
            <circle cx='88' cy='60' r='2.6' fill={A} />
            <circle cx='144' cy='54' r='2.6' fill={A} />
        </>
    ),
    // Des identifiants masqués, rangés, dont un est déverrouillé.
    password: (
        <>
            <Card x={14} y={16} w={132} h={18} />
            <circle cx='27' cy='25' r='5' stroke={A} {...thin} />
            <Line x={38} y={20} w={38} o={0.7} />
            <Line x={38} y={27} w={68} o={0.35} h={4} />
            <Card x={14} y={38} w={132} h={18} c={A} o={0.18} />
            <path d='M23 25v0' stroke={A} {...thin} />
            <path d='M23 45v-3a4 4 0 0 1 8 0' stroke={A} {...stroke} />
            <rect x='21' y='45' width='12' height='9' rx='2' fill={A} opacity='0.9' />
            <Line x={40} y={42} w={44} c={A} o={0.8} />
            <circle cx='42' cy='51' r='2' fill={M} opacity='0.7' />
            <circle cx='49' cy='51' r='2' fill={M} opacity='0.7' />
            <circle cx='56' cy='51' r='2' fill={M} opacity='0.7' />
            <circle cx='63' cy='51' r='2' fill={M} opacity='0.7' />
            <circle cx='70' cy='51' r='2' fill={M} opacity='0.7' />
            <Card x={14} y={60} w={132} h={18} />
            <circle cx='27' cy='69' r='5' stroke={M} {...thin} />
            <Line x={38} y={64} w={30} o={0.7} />
            <Line x={38} y={71} w={56} o={0.35} h={4} />
        </>
    ),
    // Une note écrite, son coin replié, et un passage surligné.
    notes: (
        <>
            <path d='M34 12h72l20 20v46a4 4 0 0 1-4 4H34a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z' fill={M} opacity='0.14' />
            <path d='M34 12h72l20 20v46a4 4 0 0 1-4 4H34a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4Z' stroke={M} {...thin} />
            <path d='M106 12v20h20' stroke={M} {...thin} />
            <Line x={42} y={40} w={64} o={0.5} />
            <rect x='42' y='50' width='52' height='7' rx='3.5' fill={A} opacity='0.4' />
            <Line x={42} y={62} w={72} o={0.5} />
            <Line x={42} y={71} w={40} o={0.3} h={4} />
        </>
    ),
    // La frise de sondes, le dessin qui appartient à Uptime et à personne d'autre.
    uptime: (
        <>
            <Line x={14} y={16} w={44} c={A} o={0.85} h={6} />
            <Line x={122} y={16} w={24} o={0.3} h={6} />
            <rect x='14' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='24' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='34' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='44' y='34' width='5' height='30' rx='2.5' fill={WARN} opacity='0.9' />
            <rect x='54' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='64' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='74' y='34' width='5' height='30' rx='2.5' fill={KO} opacity='0.9' />
            <rect x='84' y='34' width='5' height='30' rx='2.5' fill={KO} opacity='0.9' />
            <rect x='94' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='104' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='114' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='124' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <rect x='134' y='34' width='5' height='30' rx='2.5' fill={OK} opacity='0.85' />
            <Line x={14} y={72} w={26} o={0.3} h={4} />
            <Line x={120} y={72} w={26} o={0.3} h={4} />
        </>
    ),
    // Un bouclier, et le balayage qui vient de trouver quelque chose.
    sentinel: (
        <>
            <path d='M80 12 116 24v22c0 20-15 30-36 34-21-4-36-14-36-34V24Z' fill={A} opacity='0.14' />
            <path d='M80 12 116 24v22c0 20-15 30-36 34-21-4-36-14-36-34V24Z' stroke={A} {...stroke} />
            <path d='M62 46a18 18 0 0 1 36 0' stroke={M} {...thin} />
            <path d='M70 54a10 10 0 0 1 20 0' stroke={M} {...thin} />
            <circle cx='80' cy='46' r='2.6' fill={A} />
            <circle cx='95' cy='34' r='3.4' fill={KO} />
        </>
    ),
    // Deux appareils, un nuage, et le va-et-vient entre les trois.
    cloudsync: (
        <>
            <path
                d='M62 40h40a12 12 0 0 0 0-24 16 16 0 0 0-30-4 11 11 0 0 0-10 28Z'
                fill={A}
                opacity='0.18'
                stroke={A}
                strokeWidth='2.4'
                strokeLinejoin='round'
            />
            <rect x='16' y='58' width='42' height='24' rx='4' fill={M} opacity='0.18' />
            <rect x='16' y='58' width='42' height='24' rx='4' stroke={M} {...thin} />
            <rect x='102' y='58' width='42' height='24' rx='4' fill={M} opacity='0.18' />
            <rect x='102' y='58' width='42' height='24' rx='4' stroke={M} {...thin} />
            <path d='M46 54 62 44' stroke={A} {...stroke} />
            <path d='M56 44h6v6' stroke={A} {...stroke} />
            <path d='M114 54 98 44' stroke={A} {...stroke} />
            <path d='M104 44h-6v6' stroke={A} {...stroke} />
        </>
    ),
    // Un tableau : trois colonnes, des cartes, et celle qu'on est en train de bouger.
    projects: (
        <>
            <Card x={14} y={14} w={40} h={64} o={0.1} />
            <Card x={60} y={14} w={40} h={64} o={0.1} />
            <Card x={106} y={14} w={40} h={64} o={0.1} />
            <Line x={18} y={20} w={22} o={0.45} h={4} />
            <Line x={64} y={20} w={26} o={0.45} h={4} />
            <Line x={110} y={20} w={18} o={0.45} h={4} />
            <Card x={18} y={30} w={32} h={14} />
            <Card x={18} y={48} w={32} h={14} />
            <Card x={64} y={30} w={32} h={14} c={A} o={0.42} />
            <Card x={64} y={48} w={32} h={14} />
            <Card x={110} y={30} w={32} h={14} />
        </>
    ),
    // Le graphe des commits : deux voies, une bifurcation, une fusion. Deux
    // hauteurs franches et des raccords en S — un simple arc au-dessus du tronc
    // se lisait comme une colline, pas comme une branche.
    git: (
        <>
            <line x1='14' y1='62' x2='146' y2='62' stroke={M} strokeWidth='2.4' strokeLinecap='round' />
            <path d='M52 62C64 62 64 32 76 32' stroke={A} {...stroke} />
            <line x1='76' y1='32' x2='108' y2='32' stroke={A} strokeWidth='2.4' strokeLinecap='round' />
            <path d='M108 32C120 32 120 62 132 62' stroke={A} {...stroke} />
            <circle cx='14' cy='62' r='4.5' fill={M} opacity='0.55' />
            <circle cx='52' cy='62' r='5.5' fill={A} />
            <circle cx='92' cy='62' r='4.5' fill={M} opacity='0.55' />
            <circle cx='132' cy='62' r='5.5' fill={A} />
            <circle cx='80' cy='32' r='5.5' fill={A} />
            <circle cx='104' cy='32' r='5.5' fill={A} />
            <Line x={14} y={76} w={54} o={0.28} h={4} />
            <Line x={78} y={76} w={30} o={0.28} h={4} />
        </>
    ),
    // Le trajet d'une mise en production, et sa barre d'avancement.
    deploy: (
        <>
            <rect x='14' y='26' width='34' height='26' rx='4' fill={M} opacity='0.18' />
            <rect x='14' y='26' width='34' height='26' rx='4' stroke={M} {...thin} />
            <path d='M54 39h34' stroke={A} {...stroke} />
            <path d='M82 33l6 6-6 6' stroke={A} {...stroke} />
            <rect x='96' y='20' width='50' height='38' rx='5' fill={A} opacity='0.16' />
            <rect x='96' y='20' width='50' height='38' rx='5' stroke={A} {...stroke} />
            <Line x={104} y={28} w={34} c={A} o={0.7} h={4} />
            <Line x={104} y={38} w={22} o={0.45} h={4} />
            <Line x={14} y={70} w={132} o={0.18} h={7} />
            <Line x={14} y={70} w={92} c={A} o={0.85} h={7} />
        </>
    ),
    // Le cylindre, et la table qu'on est en train de parcourir.
    database: (
        <>
            <ellipse cx='42' cy='24' rx='26' ry='9' fill={A} opacity='0.22' />
            <ellipse cx='42' cy='24' rx='26' ry='9' stroke={A} {...thin} />
            <path d='M16 24v34c0 5 12 9 26 9s26-4 26-9V24' stroke={A} {...stroke} />
            <path d='M16 41c0 5 12 9 26 9s26-4 26-9' stroke={A} {...thin} />
            <rect x='84' y='18' width='62' height='54' rx='4' fill={M} opacity='0.12' />
            <rect x='84' y='18' width='62' height='54' rx='4' stroke={M} {...thin} />
            <line x1='84' y1='32' x2='146' y2='32' stroke={M} {...thin} />
            <line x1='84' y1='46' x2='146' y2='46' stroke={M} {...thin} />
            <line x1='84' y1='59' x2='146' y2='59' stroke={M} {...thin} />
            <line x1='112' y1='18' x2='112' y2='72' stroke={M} {...thin} />
        </>
    ),
    // Un solde qui monte, et le journal des opérations sous lui.
    finance: (
        <>
            <rect x='16' y='52' width='14' height='22' rx='3' fill={A} opacity='0.35' />
            <rect x='36' y='42' width='14' height='32' rx='3' fill={A} opacity='0.5' />
            <rect x='56' y='46' width='14' height='28' rx='3' fill={A} opacity='0.4' />
            <rect x='76' y='30' width='14' height='44' rx='3' fill={A} opacity='0.75' />
            <path d='M23 46 43 34 63 38 83 20' stroke={A} {...stroke} />
            <circle cx='83' cy='20' r='3.4' fill={A} />
            <Line x={104} y={26} w={42} o={0.45} />
            <Line x={104} y={38} w={30} c={OK} o={0.8} />
            <Line x={104} y={50} w={36} o={0.35} />
            <Line x={104} y={62} w={24} c={KO} o={0.7} />
        </>
    ),
    // L'entonnoir des visiteurs — visites, sessions, conversions — et la
    // tendance à côté. Un entonnoir plutôt qu'une courbe : Monitoring en porte
    // déjà une, et deux aires empilées voisines ne se distingueraient pas.
    audience: (
        <>
            <rect x='16' y='20' width='84' height='14' rx='7' fill={A} opacity='0.75' />
            <rect x='16' y='40' width='60' height='14' rx='7' fill={A} opacity='0.5' />
            <rect x='16' y='60' width='34' height='14' rx='7' fill={A} opacity='0.32' />
            <line x1='112' y1='74' x2='112' y2='18' stroke={M} {...thin} />
            <line x1='112' y1='74' x2='148' y2='74' stroke={M} {...thin} />
            <path d='M116 64 126 52 134 56 146 30' stroke={A} {...stroke} />
            <circle cx='126' cy='52' r='2.8' fill={A} />
            <circle cx='146' cy='30' r='2.8' fill={A} />
        </>
    ),
    // Un réseau de traces, et la loupe qui vient d'en isoler une.
    osint: (
        <>
            <line x1='38' y1='26' x2='72' y2='44' stroke={M} {...thin} />
            <line x1='38' y1='66' x2='72' y2='44' stroke={M} {...thin} />
            <line x1='72' y1='44' x2='118' y2='24' stroke={M} {...thin} />
            <line x1='72' y1='44' x2='112' y2='62' stroke={M} {...thin} />
            <circle cx='38' cy='26' r='4.5' fill={M} opacity='0.6' />
            <circle cx='38' cy='66' r='4.5' fill={M} opacity='0.6' />
            <circle cx='118' cy='24' r='4.5' fill={M} opacity='0.6' />
            <circle cx='72' cy='44' r='6' fill={A} />
            <circle cx='112' cy='62' r='16' fill={A} opacity='0.12' />
            <circle cx='112' cy='62' r='16' stroke={A} {...stroke} />
            <path d='M124 74 138 82' stroke={A} {...stroke} />
        </>
    ),
    // Une enveloppe, et la pile de messages derrière elle.
    mail: (
        <>
            <Card x={26} y={12} w={108} h={10} o={0.14} />
            <Card x={20} y={22} w={120} h={10} o={0.2} />
            <rect x='14' y='32' width='132' height='46' rx='5' fill={A} opacity='0.16' />
            <rect x='14' y='32' width='132' height='46' rx='5' stroke={A} {...stroke} />
            <path d='M14 36 80 62 146 36' stroke={A} {...stroke} />
            <circle cx='140' cy='38' r='6' fill={KO} />
        </>
    ),

    // ── Les trois autres genres de tuile ────────────────────────────────────
    // Une machine : son nom, son état, et l'activité qui la traverse.
    device: (
        <>
            <rect x='18' y='18' width='124' height='54' rx='6' fill={M} opacity='0.14' />
            <rect x='18' y='18' width='124' height='54' rx='6' stroke={M} {...thin} />
            <Line x={28} y={28} w={48} c={A} o={0.85} />
            <circle cx='132' cy='30.5' r='4' fill={OK} />
            <Line x={28} y={44} w={30} o={0.2} h={6} />
            <Line x={28} y={44} w={22} c={A} o={0.75} h={6} />
            <Line x={66} y={44} w={30} o={0.2} h={6} />
            <Line x={66} y={44} w={14} c={A} o={0.55} h={6} />
            <Line x={104} y={44} w={30} o={0.2} h={6} />
            <Line x={104} y={44} w={9} c={A} o={0.4} h={6} />
            <Line x={28} y={58} w={62} o={0.28} h={4} />
        </>
    ),
    // Un lien épinglé : son logo, son titre, et le badge du service.
    shortcut: (
        <>
            <rect x='18' y='20' width='124' height='50' rx='6' fill={A} opacity='0.14' />
            <rect x='18' y='20' width='124' height='50' rx='6' stroke={A} {...thin} />
            <circle cx='42' cy='38' r='11' fill={A} opacity='0.55' />
            <Line x={60} y={32} w={50} c={A} o={0.8} />
            <Line x={60} y={42} w={34} o={0.4} h={4} />
            <rect x='122' y='26' width='12' height='12' rx='3' fill={M} opacity='0.5' />
            <Line x={30} y={56} w={26} o={0.3} h={4} />
            <Line x={62} y={56} w={26} o={0.3} h={4} />
        </>
    ),
    // Un dossier, et ce qui dépasse de dedans.
    folder: (
        <>
            <Card x={44} y={16} w={30} h={20} o={0.3} />
            <Card x={80} y={16} w={30} h={20} o={0.2} />
            <path
                d='M20 30h34l8 10h78a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V34a4 4 0 0 1 4-4Z'
                fill={A}
                opacity='0.2'
            />
            <path
                d='M20 30h34l8 10h78a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V34a4 4 0 0 1 4-4Z'
                stroke={A}
                {...stroke}
            />
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
